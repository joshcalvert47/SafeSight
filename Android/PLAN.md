# SafeSight Android — Implementation Plan

Native Android port of SafeSight: an in-app filtered browser (ML image blur)
and app blocking via an accessibility shield. Distributed on Google Play. Built
into this Gradle scaffold (`com.joshc.safesight`, Kotlin + Jetpack Compose).

## Scope

| Feature | Mechanism | Reused from |
|---|---|---|
| Image ML blur | WebView injects `chrome/content.js` + a JS shim faking `chrome.storage`/`chrome.runtime`; `ANALYZE` → LiteRT → `AI_RESULT` via `evaluateJavascript` | `chrome/content.js` (near-unmodified), score math from `chrome/offscreen.js:80-86` |
| CORS-free image proxy | OkHttp fetch behind the `FETCH_IMAGE` bridge | `chrome/service-worker.js` |
| Site blocklist (in-app) | `shouldOverrideUrlLoading` + local `blocked.html` page | same sources |
| App blocking | `AccessibilityService` (`TYPE_WINDOW_STATE_CHANGED`) → `TYPE_ACCESSIBILITY_OVERLAY` shield | `safari/.../AppBlockingManager.swift` semantics |
| PIN gate / account | `WorkerClient` on `/api/register`, `/api/verify`, `/api/unlock-request`, `/api/unlock-status` | `chrome/popup.js` (`ensureRegistered`, `guardDestructive`), `worker/worker.js` unchanged |
| Settings | DataStore, keys identical to `chrome.storage` | `chrome/popup.js`, `chrome/content.js` |

Out of scope for v1: DoH/Private-DNS bypass hardening, cross-device sync of
stats.

## Package layout

```
app/src/main/java/com/joshc/safesight/
├── MainActivity.kt
├── ml/NsfwClassifier.kt              # phase 2
├── browser/FilterWebView.kt          # phase 3
├── browser/ChromeShim.kt             # phase 3
├── block/BlocklistRepository.kt      # phase 4
├── block/BlockAccessibilityService.kt # phase 6
├── data/SettingsStore.kt             # phase 1
├── net/WorkerClient.kt               # phase 1
└── ui/  (ViewModel, screens, PinDialog)
app/src/main/assets/                  # nsfw.tflite, content.js, blocked.html, blocklist.json
```

## Phases

1. **Shell + account** — deps (okhttp, datastore), `INTERNET` permission,
   `WorkerClient`, `SettingsStore`, onboarding/settings/PIN Compose screens.
   Destructive settings (disable skin filter, disable blur-all, remove a
   blocklist site) are PIN-gated through `POST /api/verify`, matching
   `popup.js guardDestructive()`.
2. **Classifier** — `nsfw.tflite` → `assets/`; LiteRT Android loads
   `[1,224,224,3]`; divide input by 255 when the model input is float32;
   softmax-normalize logits when any value > 1; score =
   `(porn[3] + hentai[1] + sexy[4]) * 10`, `neutral > 0.85 && score < 2 → 0`,
   clamp+round 0–10; fail-open (score 0) on error. Unit-tested against
   vectors from `chrome/modeltest/test.html`.
3. **Filtered browser** — copy `content.js` to `assets/`; bridge the four
   `chrome.*` surfaces it uses (storage get/set/onChanged, `sendMessage`
   ANALYZE/FETCH_IMAGE/BLOCK_SITE_NAV/BUMP_STATS, `onMessage`
   AI_RESULT/SITE_TOGGLE/RESCAN_PAGE, `getURL`); keep content.js's blur-first
   reveal, verdict cache, scan queue, center-crop retry and skin overlay as-is.
4. **Blocklist repository** — port `normalizeSite()` + defaults seeding
   (`blocklist.json` → `blocklistDefaults`, user adds/removes in
   `blocklistUser`/`blocklistRemoved`); in-app `blocked.html` interception.
   Shipped defaults remain locked (enforced but not removable), same as the
   extensions.
5. **App blocking** — accessibility service watches the foreground package and
   raises a shield overlay for blocked apps; allow/block picker UI.
6. **Play prep** — accessibility declaration, privacy policy,
   data-safety form (email + deviceId go to the worker), AAB size check
   (~40 MB install with the model).

The earlier plan for device-wide blocking via a local DNS VPN
(`SafeSightVpnService`) was cut; site blocking stays inside the in-app
browser, matching the iOS app after its DNS tunnel was removed.

## Risks / accepted limitations

- **Play review**: the accessibility declaration — wording must describe the
  parental/content-safety purpose precisely.
- **Device reach**: scaffold sets `minSdk 34`, excluding Android 13 and below.
  Revisit before launch (26 costs nothing).
- Fail-open analysis (score 0) mirrors the extensions: a model error reveals
  the image rather than permanently blocking the page.
