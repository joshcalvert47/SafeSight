# Plan: porting uBlock Origin Lite's features into SafeSight

Status: proposal, not started. Scope: the **Chrome** extension (`chrome/`) first, Firefox
(`firefox/`) as a later parity pass.

> **Update — accounts, sign-in and the server have been removed.** There is no longer a
> worker (`worker/`), a sign-in page (`login.html`/`login.js`), a Firebase SDK, or the
> `identity`/`oauth2` manifest entries. The extension is local-only: filtering and blocking
> are unconditional and `accountReady` no longer exists anywhere. Parts of this plan that
> describe account gating, the popup explaining what "the account" protects, or the worker
> host being allowlisted are therefore historical — they record what the code looked like
> when this was written, and the specific claims are corrected inline below.

---

## 1. The decision this plan encodes

The request was "add the code from ublock origin lite to safesight". Two facts make a
literal copy of that code the wrong move, so this plan **reimplements uBOL's features
natively** instead of vendoring its source:

1. **uBOL is GPL-3.0.** Dropping its source into SafeSight's extension would put the whole
   extension under GPL-3.0 — SafeSight could still be sold, but the extension's source would
   have to be published. That is a product decision, not a technical one, and it would be
   hard to walk back later.
2. **uBOL's shipped rulesets are not all commercially redistributable.** Its default set
   includes Peter Lowe's list, whose license forbids use "in a manner that could make
   anybody money". Shipping uBOL's bundled rulesets as-is in a paid product is a licensing
   problem independent of the code.

And a third fact reframes the value: **uBOL ships no adult-content list at all.** Its
default blocking is ads, trackers and malware. So copying uBOL would *not* have delivered
the single biggest gap in SafeSight — network-level adult-site blocking — which today rests
on a twelve-domain list in `blocklist.json`.

What is worth taking is uBOL's **architecture**, which is genuinely good and is what this
plan ports:

- content blocking done declaratively by the browser before any page code runs
- filter data compiled into rulesets at build time, never fetched at runtime
- cosmetic filtering (element hiding) seeded by a point-and-click picker/zapper
- an interstitial shown when a *navigation* is blocked, rather than letting the page half-load

Because the code is reimplemented, the data can come from permissively-licensed sources.
Confirmed against the live files:

| Category | Source | License | Domains | Fetch size |
|---|---|---:|---:|---:|
| Adult content | StevenBlack `alternates/porn-only` | repo MIT; upstream sources vary | 76,798 | 2.0 MB |
| Adult content (larger) | BlockListProject `porn.txt` | MIT (header states MIT) | 953,393 | 26 MB |
| Ads & trackers | StevenBlack unified `hosts` | repo MIT; upstream sources vary | 72,537 | 2.2 MB |
| Malware / phishing | URLhaus hostfile | CC0 | 421 | 12 KB |

---

## 2. Why this fits the browser, and the number that decides feasibility

Chrome's declarativeNetRequest has a **guaranteed quota of 30,000 enabled static rules**
(`GUARANTEED_MINIMUM_STATIC_RULES`), with 100 rulesets declarable in the manifest and 50
enabled at once. There is **no documented cap on how many domains a single rule's
`requestDomains` array may hold**, and `requestDomains` matches the domain *and its
subdomains* — which is exactly the hosts-file semantics these lists use.

So the whole adult list can be packed into a handful of rules:

| Packing | Adult (76.8k) | Ads+trackers (72.5k) | Malware (421) | Total rules | Headroom vs 30,000 |
|---|---:|---:|---:|---:|---:|
| 1,000 domains/rule | 77 | 73 | 1 | **151** | 199× |
| 100 domains/rule | 768 | 726 | 5 | **1,499** | 20× |

The quota is not the binding constraint at any realistic packing size, which is why the plan
does not hinge on knowing the exact per-rule limit. Phase 0 measures it anyway.

---

## 3. Target architecture: SafeSight gains a third blocking lane

SafeSight blocks things in two places today, both *after* the page has started loading:

1. **ML image lane** — `content.js` (664 lines) queues images, `offscreen.js` runs LiteRT
   NSFW inference, verdicts become blur or block.
2. **Site-blocklist lane** — `content.js` checks `location.hostname` at document_start and
   asks the service worker to `tabs.update` to `blocked.html`.

The new lane sits *before* both, in the network stack:

3. **DNR network lane** — the browser refuses/redirects the request. The page never loads,
   no bytes are transferred, and no content script is needed to enforce it.

This lane also absorbs the existing blocklist: `enforceSiteBlock()` is excluded entirely on
`mail.google.com`, `discord.com`, `openstreetmap.org` and `google.com/maps`. A DNR rule has
neither limitation. (It used to *also* require a registered account — `accountReady` — which
is gone; the `exclude_matches` limitation still stands.)

### New files (all under `chrome/`)

| File | Purpose |
|---|---|
| `chrome/filter-manager.js` | service-worker module: category config, ruleset enable/disable, dynamic rules for user sites, badge counter |
| `chrome/cosmetic.js` | document_start content script applying user element-hiding CSS per hostname |
| `chrome/element-picker.js` | shared overlay/hover/selector-generation used by both tools |
| `chrome/zapper.js` | point-and-click element hiding, persisted |
| `chrome/picker.js` | point-and-click element selection, emits a cosmetic filter |
| `chrome/rulesets/*.json` | generated DNR rulesets (build output, committed) |
| `chrome/rulesets/SOURCES.json` | generated provenance: source URL, license, fetch date, rule count |
| `tools/build-rulesets.mjs` | build script (dev-only, never shipped) that fetches, normalises and packs |

`blocked.html` is extended rather than replaced — it already exists and is already listed in
`web_accessible_resources`.

### Manifest changes

```jsonc
"permissions": [
    // No "tabs": it only unlocks the url/title/favIconUrl fields, and
    // host_permissions "<all_urls>" already exposes those for web pages. Dropping
    // it removes the "Read your browsing history" install warning. Nothing in
    // chrome.tabs.* ever needed it.
    "storage", "offscreen", "contextMenus", "identity",
    "declarativeNetRequest",   // the new lane
    "scripting"                // zapper/picker injection
],
"commands": {
    "zap-element":   { "suggested_key": { "default": "Alt+Shift+Z" } },
    "pick-element":  { "suggested_key": { "default": "Alt+Shift+P" } }
},
"declarative_net_request": {
    "rule_resources": [
        { "id": "adult",    "enabled": true,  "path": "rulesets/adult.json" },
        { "id": "ads",      "enabled": true,  "path": "rulesets/ads-trackers.json" },
        { "id": "malware",  "enabled": true,  "path": "rulesets/malware.json" }
    ]
}
```

Note: `rule_resources` must be declared statically, so **the build script patches the
manifest's ruleset list** to stay in sync with what it generated. Everything else in the
manifest is hand-edited once.

### Category behaviour differences

Not all categories should block identically — this is the main way the port goes wrong:

| Category | `domainType` | Action | Rationale |
|---|---|---|---|
| Adult | *(unset — both)* | `redirect` to `blocked.html?url=…&category=adult` | The user is *navigating* to it; they must see why |
| Ads & trackers | `thirdParty` | `block` | Invisible, and restricted to third-party so shared/CDN domains on a hosts list don't break first-party site content |
| Malware / phishing | *(unset — both)* | `redirect` to `blocked.html?…&category=malware` | Matches today's interstitial expectation |

Applying the StevenBlack lists first-party for ads would be the classic hosts-list breakage
(blocking a domain that is also a legitimate CDN). Third-party-only for that category is the
deliberate choice.

### Rule id and priority scheme

Static rule ids live in their own namespace per ruleset, so they can start at 1. Runtime
rules use reserved ranges so they can never collide with a regenerated build:

| Range | Owner | Priority |
|---|---|---|
| dynamic `1`–`19,999` | user's own blocked sites (packed 1,000/rule) | 10 |
| dynamic `20,000`–`20,099` | per-site "turn filtering off here" allow rules | 1,000 |
| session `1`–`99` | temporary unbreak for the current tab | 2,000 |

Allow rules must always outrank block rules, or "unbreak this site" silently doesn't work.

### Counting matched blocks

Use `chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true })`,
which gives a per-tab blocked count on the toolbar badge **with no extra permission**.
Avoid `declarativeNetRequestFeedback` / `getMatchedRules` / `onRuleMatchedDebug`: they are
developer-oriented, trigger an additional permission warning, and are not needed for a user
counter.

---

## 4. Phases

### Phase 0 — Feasibility spike (half a day)

The only genuinely unknown thing is the practical `requestDomains` array size. Measure it
before building anything.

- Build a throwaway extension declaring one ruleset containing packed `requestDomains` arrays
  of 1,000 / 5,000 / 20,000 domains, and confirm Chrome loads it, blocks a match, and
  matches a subdomain of a listed domain.
- Record `getAvailableStaticRuleCount()` and `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`.
- **Tooling note:** the installed Chrome 155 refuses `--load-extension`, which is why the
  earlier auth work could not drive the UI. For this, install Chrome for Testing
  (`npx @puppeteer/browsers install chrome@stable`) which still honours the flag, or load
  unpacked manually at `chrome://extensions`.

**Exit criteria:** a packed ruleset loads and blocks a live request; a chunk size is chosen
with evidence. If arrays must stay small, Phase 1 chunk size drops and the plan still holds
(20× headroom at 100/rule).

### Phase 1 — Build pipeline (`tools/build-rulesets.mjs`)

- Fetch each source, parse hosts/plain formats, normalise to bare registrable domains, drop
  `localhost` / `0.0.0.0` / `broadcasthost` / `ip6-*` noise lines, lowercase, dedupe, sort.
- Subtract an internal **allowlist** of domains that must never be blocked (Google/Firebase
  identity endpoints, so third-party sign-in on ordinary sites keeps working, plus the CDNs
  and font/code hosts that hosts lists routinely catch). The SafeSight worker host used to be
  here too; the worker and the extension's own sign-in are gone.
- Pack into `requestDomains` arrays at the Phase 0 chunk size; emit
  `{ id, priority, action, condition }` rules per category.
- Write `SOURCES.json` with source URL, license, fetch date and rule/domain counts, so
  attribution and provenance ship with the build.
- Patch the manifest `rule_resources` list.
- **Never fetch lists at runtime.** Compiled rulesets ship with the extension, exactly as
  uBOL does; runtime fetching adds a CSP/review/reliability problem for no gain.

**Verify:** rule counts match the table in §2; no allowlisted domain appears; the emitted
JSON validates against Chrome's DNR rule schema; total `chrome/rulesets/` size is within a
chosen budget (target < 4 MB using StevenBlack sources; the 953k-domain BlockListProject
list is a deliberate opt-in, not the default).

### Phase 2 — DNR engine in the service worker

- `filter-manager.js`: read/write `filterCategories` in `chrome.storage.local`; map category →
  ruleset id; call `updateEnabledRulesets()`; guard with `getAvailableStaticRuleCount()` and
  surface a real error if a ruleset can't be enabled.
- Compile the user's own blocked sites into **dynamic** rules on every change, so popup edits
  apply immediately without a rebuild (static rulesets are immutable per extension version).
- Wire `onInstalled` / `onStartup` to reconcile stored categories against actually-enabled
  rulesets — Chrome does not persist enabled static rulesets across extension updates,
  a documented gotcha that silently turns filtering off after every release.
- Set the badge counter.

**Verify:** toggling each category adds/removes rules and takes effect without a reload;
navigating to a listed adult domain shows `blocked.html` with no page bytes loaded; an
ad/tracker request on a normal page is blocked and the page still works; a domain on the
allowlist is never blocked.

### Phase 3 — Popup controls

Extend `popup.html` in the existing idiom (`control-item` + `switch` markup from
`popup.css`, storage keys, `chrome.storage.onChanged` re-render — all already there):

- Category switches: **Adult content**, **Ads & trackers**, **Malware & phishing**.
- "Filtering is off on this site" state + an unbreak button, writing a dynamic allow rule.
- The blocked count, sourced from the badge counter.
- Lost-control warning: this is local preference storage, so a user can switch categories off.
  The popup should say plainly what is protected by the account and what is not, rather than
  implying parental control that isn't enforced.

### Phase 4 — Blocked page and strictblock

- Extend `blocked.html` to render the category and the attempted URL, with the existing
  styling.
- Emit `redirect` rules for navigation-level categories so a blocked *navigation* becomes the
  interstitial (uBOL calls this strictblock) rather than a half-loaded page.
- Keep the "fail open" behaviour: if a redirect target is unavailable the request must not
  hang.

### Phase 5 — Zapper and picker

- `element-picker.js`: hover outline, element highlight, and a `selectorForElement()` helper
  that builds a stable unique CSS path.
- `zapper.js`: click hides the element immediately, persists `{ hostname: [selectors] }` to
  `chrome.storage.local.userCSS`, and reports each zap to the service worker so the popup can
  show it.
- `cosmetic.js`: document_start content script that injects one `<style>` per hostname with
  `display:none !important` rules from `userCSS`. Must run at document_start to avoid a flash
  of the element.
- `picker.js`: same overlay, but the chosen selector is shown with a copy/export action
  (uBOL's picker generates filters; a full cosmetic-filter compiler is out of scope).
- Injected on demand via `chrome.scripting.executeScript` from the popup button or the
  keyboard command.

**Verify:** a zapped element stays hidden after reload and in new tabs on the same site;
zapping on one site does not affect another; the picker's selector actually matches the
element it generated from (test against a DOM with duplicate classes).

### Phase 6 — Fold the old lane in, keep the fallback

- Move the shipped `blocklist.json` domains into the adult ruleset's allowlist-aware set, or
  keep them as dynamic rules; either way the content-script navigation block becomes
  redundant for known domains.
- Keep `enforceSiteBlock()` in `content.js` as the fallback path. **Done:** the
  `accountReady` gate has been dropped, so blocking does not depend on a server — there is no
  longer one.
- Re-survey `exclude_matches` in the manifest: with DNR, those exclusions no longer leak a
  blocked site through a content script.

### Phase 7 — Hardening

- False-positive guard: an "unbreak this site" flow that adds a high-priority allow rule, and
  a log of recently blocked domains so a support report can be acted on.
- Stats semantics: the popup's "Blocked" tile currently means *images blocked by ML*. Network
  blocks are a different thing. Decide whether to merge or show separately — separate is
  honest and avoids a number that jumps for no visible reason.
- Size/packaging: **`chrome/Archive.zip` (57 MB) must be excluded from packaging**, as must
  `chrome/modeltest/` and any vendored reference folder. A `chrome/.gitignore` or build
  filter should enforce it, otherwise a Web Store upload carries 57 MB of dead weight.
- Firefox parity pass over `firefox/` (DNR exists in Firefox MV3 but with its own limits and
  `requestDomains` differences — verify rather than assume).
- The Android app's `chrome-shim.js` and its `blocklist.json` should eventually share the
  generated ruleset so the platforms don't drift.

---

## 5. Housekeeping this plan depends on

- **Remove `ublock-origin-lite/` from the working tree** (or gitignore it). It is 36 MB of
  GPL-3.0 code and ~925 files sitting untracked in a commercial repo. It is useful as a local
  reference for the phases above; it should never be committed, bundled, or shipped. Its
  author's copyright and license must not be stripped if any snippet were ever reused, which
  is another reason to reimplement rather than copy.

---

## 6. Risks / open questions

| Risk | Mitigation |
|---|---|
| Adding `declarativeNetRequest` + `scripting` + `<all_urls>` **re-prompts every existing install** and widens the Web Store permission warning | Batch into one release; the parental-control category is a legitimate reason for broad host access |
| Hosts lists are blunt — blocking a whole domain can break shared infrastructure | `thirdParty` for ads; ship an allowlist; easy unbreak |
| StevenBlack's merged lists aggregate upstream sources with **varying licenses**; the BlockListProject header states MIT and URLhaus is CC0, but "the repo is MIT" does not automatically cover every merged source | Record per-source license in `SOURCES.json`; treat the adult and malware lists (whose own headings state MIT/CC0) as the confident ones and review the ads list before commercial release |
| Extension size growth (2–28 MB of rulesets) and slower review | StevenBlack sources only by default; the 953k-domain BlockListProject list stays opt-in |
| Content-script contention — `content.js` already runs at document_start, all frames | `cosmetic.js` is separate and idempotent; measure page-load impact before/after |
| A future uBOL feature would need reimplementing rather than copied | Accepted; that is the cost of staying closed-source |
| Chrome's static rulesets are **not persisted across extension updates** | Explicit reconciliation on `onInstalled` (Phase 2) |

---

## 7. Definition of done

- Navigating to a domain on the adult list shows `blocked.html` with zero page bytes loaded,
  including subdomains, including in an iframe.
- Ad/tracker requests are blocked on a normal page without breaking that page.
- A malware URL is redirected to the interstitial.
- Category switches take effect in under a second, survive a browser restart, and survive an
  extension update.
- Zapped elements stay hidden across reloads and tabs; the picker's generated selector
  matches its target.
- `SOURCES.json` names the license of every shipped ruleset.
- Verified in a real browser, not just by a build succeeding — using Chrome for Testing if the
  system Chrome keeps refusing `--load-extension`.
