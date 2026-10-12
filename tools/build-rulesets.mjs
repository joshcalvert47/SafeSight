// tools/build-rulesets.mjs
//
// Dev-only build step. NEVER shipped with the extension and never run at
// runtime by it: it fetches the upstream filter sources, normalises them to
// bare domains, packs them into Chrome declarativeNetRequest rulesets under
// chrome/rulesets/, records provenance in chrome/rulesets/SOURCES.json, and
// patches chrome/manifest.json's rule_resources list so the manifest can never
// drift from what was generated.
//
// Why a build step rather than runtime fetching: uBlock Origin Lite compiles
// its filter data at build time for exactly this reason — a ruleset that ships
// with the extension needs no CSP exception, no network permission beyond what
// blocking already implies, no failure mode when a CDN is down, and no review
// question about downloading executable-ish data after install.
//
// Licensing: every source below is redistributable. The StevenBlack repository
// is MIT but is itself a *merger* of upstream lists with varying licenses, so
// the per-source license is recorded in SOURCES.json for review; the layers
// that matter commercially are the ones whose own headings state MIT (the
// BlockListProject porn list) and CC0 (URLhaus). uBlock Origin Lite's own
// GPL-3.0 code and its bundled rulesets (which include Peter Lowe's
// non-commercial list) are deliberately NOT used here.
//
// Usage:
//   node tools/build-rulesets.mjs                  # default sources
//   node tools/build-rulesets.mjs --with-blp       # also fold in the 953k-domain
//                                                  # BlockListProject porn list
//   node tools/build-rulesets.mjs --chunk=100      # packing size per rule
//   node tools/build-rulesets.mjs --offline        # reuse tools/.cache/*.txt

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'chrome');
const OUT_DIR = path.join(EXT_DIR, 'rulesets');
const CACHE_DIR = path.join(ROOT, 'tools', '.cache');

// ---------------------------------------------------------------------------
// Category configuration.
//
// The categories are NOT blocked identically, because "block everything on this
// hosts list in every context" is how hosts lists break real sites:
//
//   adult    navigation to it must explain itself  -> redirect interstitial
//   malware  same                                   -> redirect interstitial
//   ads      invisible, and a hosts list contains plenty of shared/CDN
//            domains that a page may legitimately need first-party, so it is
//            restricted to third-party requests only  -> block
//
// For adult/malware, navigation (main_frame/sub_frame) gets the interstitial
// while subresources are simply blocked — redirecting an <img> to an HTML
// interstitial would render a broken page instead of a useful one.
// ---------------------------------------------------------------------------
const CATEGORIES = [
    {
        id: 'adult',
        label: 'Adult content',
        source: 'stevenblack-porn',
        navigate: 'redirect',
        subresource: 'block',
        thirdPartyOnly: false,
        interstitial: 'adult'
    },
    {
        id: 'malware',
        label: 'Malware & phishing',
        source: 'urlhaus',
        navigate: 'redirect',
        subresource: 'block',
        thirdPartyOnly: false,
        interstitial: 'malware'
    },
    {
        id: 'ads',
        label: 'Ads & trackers',
        source: 'stevenblack-unified',
        navigate: 'block',
        subresource: 'block',
        thirdPartyOnly: true,
        interstitial: null
    }
];

const SOURCES = {
    'stevenblack-porn': {
        url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts',
        format: 'hosts',
        license: 'StevenBlack repo: MIT. Merged upstream sources vary — review before commercial release.',
        attribution: 'StevenBlack/hosts (alternates/porn-only)'
    },
    'stevenblack-unified': {
        url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
        format: 'hosts',
        license: 'StevenBlack repo: MIT. Merged upstream sources vary — review before commercial release.',
        attribution: 'StevenBlack/hosts (unified hosts + fakenews + gambling + social)'
    },
    urlhaus: {
        url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
        format: 'hosts',
        license: 'CC0 (public domain dedication)',
        attribution: 'abuse.ch URLhaus hostfile'
    },
    'blp-porn': {
        url: 'https://blocklistproject.github.io/Lists/porn.txt',
        format: 'hosts',
        license: 'MIT (stated in the file header)',
        attribution: 'BlockListProject/Lists porn.txt'
    }
};

// ---------------------------------------------------------------------------
// Domains that must never be blocked, whatever a hosts list says.
//
// Keeps the shared infrastructure that hosts lists routinely catch unblocked
// (CDNs, font hosts, code hosts). Google is deliberately included: the ads list
// carries Google's own ad domains, and third-party-only rules would otherwise
// break reCAPTCHA, Google sign-in and embedded YouTube on unrelated sites.
//
// SafeSight's own backend (funbyte.net) was here too, for the same reason: the
// extension talked to it. That server and the sign-in it served are gone, so
// there is nothing of ours left to keep reachable.
// ---------------------------------------------------------------------------
const ALLOWLIST = [
    // Google / Firebase identity on *other* people's sites — quite apart from
    // SafeSight's own (removed) sign-in, blocking these breaks third-party
    // logins, so they stay.
    'google.com',
    'googleapis.com',
    'gstatic.com',
    'googleusercontent.com',
    'googlevideo.com',
    'youtube.com',
    'ytimg.com',
    'ggpht.com',
    'firebaseapp.com',
    'firebaseio.com',
    'firebaseinstallations.googleapis.com',
    // NOTE: google-analytics.com is deliberately NOT here — it is a tracker
    // and blocking it is the point of the ads category.
    // Shared infrastructure: blocking these breaks pages rather than ads.
    'cloudflare.com',
    'cloudflare-dns.com',
    'cdnjs.cloudflare.com',
    'jsdelivr.net',
    'unpkg.com',
    'fastly.net',
    'akamai.net',
    'akamaized.net',
    'amazonaws.com',
    'cloudfront.net',
    'azureedge.net',
    'bootstrapcdn.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'typekit.net',
    'w3.org',
    'schema.org',
    'wikipedia.org',
    'wikimedia.org',
    'archive.org',
    'github.com',
    'githubusercontent.com',
    'apple.com',
    'icloud.com',
    'cdn-apple.com',
    'microsoft.com',
    'microsoftonline.com',
    'live.com',
    'windowsupdate.com',
    'mozilla.org',
    'mozilla.net',
    'duckduckgo.com'
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Hosts-file noise: loopback, broadcast and IPv6 placeholder rows carry no
// blockable domain.
const NOISE_DOMAINS = new Set([
    'localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost',
    'ip6-loopback', 'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters',
    'ip6-allhosts', '0.0.0.0', '127.0.0.1', '::1', 'localhost6', 'localhost6.localdomain6'
]);

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Turn one hosts-list line into a normalised bare domain, or null.
 * Handles both "0.0.0.0 domain" / "127.0.0.1 domain" (StevenBlack, BlockList)
 * and "127.0.0.1<TAB>domain" (URLhaus), plus trailing CR and comments.
 */
export function parseHostsLine(line) {
    let s = line;
    const hash = s.indexOf('#');
    if (hash !== -1) s = s.slice(0, hash);
    s = s.replace(/\r/g, '').trim();
    if (!s) return null;

    const parts = s.split(/\s+/);
    let domain = parts.length > 1 ? parts[parts.length - 1] : null;
    if (parts.length === 1) {
        // A degenerate hosts row that is only a domain (some lists do this).
        domain = parts[0];
    }
    if (!domain) return null;

    domain = domain.toLowerCase().replace(/\.$/, '');
    if (domain.startsWith('www.')) domain = domain.slice(4);
    if (!domain || NOISE_DOMAINS.has(domain)) return null;
    if (IPV4_RE.test(domain)) return null;      // bare IP literal, not a domain
    // Upstream quirk: some rows carry a doubled address, e.g.
    // "0.0.0.0 0.0.0.0.creative.example.com", which parses to a nonsense domain.
    if (/^(?:0\.){4}\./.test(domain) || domain.includes('..')) return null;
    if (!domain.includes('.')) return null;     // single label / TLD-only entries
    if (!DOMAIN_RE.test(domain)) return null;
    return domain;
}

/** Parse a whole hosts file into a sorted, unique domain array. */
export function parseHostsFile(text) {
    const out = new Set();
    for (const line of text.split('\n')) {
        const d = parseHostsLine(line);
        if (d) out.add(d);
    }
    return [...out].sort();
}

/** A domain is allowlisted if it is the entry or a subdomain of it. */
export function isAllowlisted(domain, allowlist = ALLOWLIST) {
    return allowlist.some((a) => domain === a || domain.endsWith('.' + a));
}

// ---------------------------------------------------------------------------
// Rule packing
// ---------------------------------------------------------------------------

/**
 * Pack domains into declarativeNetRequest rules at `chunk` domains per rule.
 * `requestDomains` matches the domain *and all of its subdomains*, which is
 * precisely the hosts-file semantic, so one entry covers every subdomain.
 */
export function packRules({ domains, chunk, startId = 1, action, priority, thirdPartyOnly, resourceTypes, regexFilter, extensionPath }) {
    const rules = [];
    // Chrome rejects id 0 ("This should be greater than or equal to 1") and
    // rejects duplicates within a ruleset, and a category emits more than one
    // call here (navigation rules + subresource rules), so ids must continue
    // across calls rather than restarting per call.
    let n = startId;
    for (let i = 0; i < domains.length; i += chunk) {
        const slice = domains.slice(i, i + chunk);
        // regexFilter is applied to every rule, not just redirects. Measured on
        // Chrome 155: a condition of requestDomains + resourceTypes alone does
        // NOT match a main_frame request (see PHASE0 notes), while the same
        // condition with regexFilter added does. '^https?://.*' is a no-op on
        // top of requestDomains, so it is always safe to include.
        const condition = { requestDomains: slice, regexFilter: regexFilter || '^https?://.*' };
        if (resourceTypes) condition.resourceTypes = resourceTypes;
        if (thirdPartyOnly) condition.domainType = 'thirdParty';
        const ruleAction = { type: action };
        if (action === 'redirect') {
            // extensionPath, NOT regexSubstitution: measured on Chrome 155,
            // every regexSubstitution variant failed to match any request,
            // while extensionPath matched and navigated correctly. The cost is
            // that the attempted URL cannot be carried in the target, so the
            // interstitial is identified by a static per-category query string.
            ruleAction.redirect = { extensionPath };
        }
        rules.push({
            id: n++,
            priority,
            action: ruleAction,
            condition
        });
    }
    return rules;
}

// Declarative redirect target: a static extension path per category. A query
// string is allowed on extensionPath (measured), which is what carries the
// category to the page.
export function interstitialPath(category) {
    return `/blocked.html?category=${category}`;
}

/** Build every ruleset from the parsed, deduped per-category domain sets. */
export function buildRulesets(byCategory, chunk) {
    const rulesets = {};
    for (const cat of CATEGORIES) {
        const domains = byCategory[cat.id] || [];
        const navTypes = ['main_frame', 'sub_frame'];
        const subTypes = ['stylesheet', 'script', 'image', 'font', 'media', 'object',
            'xmlhttprequest', 'ping', 'csp_report', 'websocket', 'webtransport', 'other'];

        let rules = [];
        let nextId = 1;
        const add = (batch) => { rules = rules.concat(batch); nextId += batch.length; };
        const interstitial = interstitialPath(cat.interstitial || cat.id);
        if (cat.navigate === 'redirect') {
            add(packRules({
                domains, chunk, startId: nextId, action: 'redirect', priority: 20,
                thirdPartyOnly: cat.thirdPartyOnly,
                resourceTypes: navTypes,
                extensionPath: interstitial
            }));
        } else {
            add(packRules({
                domains, chunk, startId: nextId, action: 'block', priority: 10,
                thirdPartyOnly: cat.thirdPartyOnly,
                resourceTypes: navTypes
            }));
        }
        if (cat.subresource === 'redirect') {
            add(packRules({
                domains, chunk, startId: nextId, action: 'redirect', priority: 20,
                thirdPartyOnly: cat.thirdPartyOnly,
                resourceTypes: subTypes,
                extensionPath: interstitial
            }));
        } else {
            add(packRules({
                domains, chunk, startId: nextId, action: 'block', priority: 10,
                thirdPartyOnly: cat.thirdPartyOnly,
                resourceTypes: subTypes
            }));
        }
        rulesets[cat.id] = { rules, domainCount: domains.length, category: cat };
    }
    return rulesets;
}

// ---------------------------------------------------------------------------
// Fetch / cache
// ---------------------------------------------------------------------------
async function fetchSource(key, { offline }) {
    const src = SOURCES[key];
    const cacheFile = path.join(CACHE_DIR, createHash('sha256').update(src.url).digest('hex').slice(0, 16) + '.txt');
    if (offline) {
        return { text: await readFile(cacheFile, 'utf8'), cached: true };
    }
    try {
        const resp = await fetch(src.url, { headers: { 'user-agent': 'SafeSight-ruleset-builder/1.0' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile, text);
        return { text, cached: false };
    } catch (e) {
        // A source being unreachable must not silently ship a smaller list:
        // fall back to cache if we have one, otherwise fail the build.
        try {
            const text = await readFile(cacheFile, 'utf8');
            console.warn(`  ! ${src.url} unreachable (${e.message}); using cached copy`);
            return { text, cached: true };
        } catch {
            throw new Error(`cannot fetch ${src.url} and no cached copy exists: ${e.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Manifest patching
// ---------------------------------------------------------------------------
async function patchManifest(rulesets) {
    const manifestPath = path.join(EXT_DIR, 'manifest.json');
    const text = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(text);

    const ruleResources = Object.keys(rulesets)
        .filter((id) => rulesets[id].rules.length > 0)
        .map((id) => ({ id, enabled: true, path: `rulesets/${id}.json` }));

    manifest.declarative_net_request = { rule_resources: ruleResources };

    // Permissions the network lane and the element tools need. Both are added
    // idempotently so a rebuild never duplicates them.
    for (const perm of ['declarativeNetRequest', 'scripting']) {
        if (!manifest.permissions.includes(perm)) manifest.permissions.push(perm);
    }

    await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
    return ruleResources;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    const offline = args.includes('--offline');
    const withBlp = args.includes('--with-blp');
    const chunkArg = args.find((a) => a.startsWith('--chunk='));
    const chunk = chunkArg ? Math.max(1, parseInt(chunkArg.split('=')[1], 10)) : 1000;

    const wanted = [
        { category: 'adult', key: 'stevenblack-porn' },
        { category: 'malware', key: 'urlhaus' },
        { category: 'ads', key: 'stevenblack-unified' }
    ];
    if (withBlp) wanted.push({ category: 'adult', key: 'blp-porn' });

    const provenance = [];
    // Assigned in category order so the most specific list wins a domain that
    // appears in several: a domain on the adult list stays adult.
    const byCategory = { adult: new Set(), malware: new Set(), ads: new Set() };
    const claimed = new Set();

    for (const { category, key } of wanted) {
        const { text, cached } = await fetchSource(key, { offline });
        const all = parseHostsFile(text);
        let kept = 0;
        let allowlisted = 0;
        let duplicate = 0;
        for (const d of all) {
            if (isAllowlisted(d)) { allowlisted++; continue; }
            if (claimed.has(d)) { duplicate++; continue; }
            claimed.add(d);
            byCategory[category].add(d);
            kept++;
        }
        provenance.push({
            category,
            url: SOURCES[key].url,
            license: SOURCES[key].license,
            attribution: SOURCES[key].attribution,
            fetchedAt: new Date().toISOString(),
            fromCache: cached,
            domainsInSource: all.length,
            domainsKept: kept,
            domainsAllowlisted: allowlisted,
            domainsAlreadyClaimed: duplicate
        });
        console.log(`${category.padEnd(8)} ${key.padEnd(20)} ${String(all.length).padStart(8)} domains -> kept ${kept}, allowlisted ${allowlisted}, dupes ${duplicate}`);
    }

    const sorted = {};
    for (const [cat, set] of Object.entries(byCategory)) sorted[cat] = [...set].sort();

    const rulesets = buildRulesets(sorted, chunk);

    await mkdir(OUT_DIR, { recursive: true });
    // Remove stale rulesets (a renamed or dropped category) so nothing ships
    // that the manifest no longer references.
    const keep = new Set([...Object.keys(rulesets), 'SOURCES.json']);
    for (const f of await readdir(OUT_DIR)) {
        if (f.endsWith('.json') && !keep.has(f)) {
            await rm(path.join(OUT_DIR, f));
            console.log(`removed stale ruleset ${f}`);
        }
    }

    let totalRules = 0;
    let totalDomains = 0;
    for (const [id, { rules, domainCount, category }] of Object.entries(rulesets)) {
        await writeFile(path.join(OUT_DIR, `${id}.json`), JSON.stringify(rules));
        totalRules += rules.length;
        totalDomains += domainCount;
        console.log(`ruleset ${id.padEnd(8)} ${String(rules.length).padStart(5)} rules  ${String(domainCount).padStart(8)} domains  (${category.label})`);
    }

    const ruleResources = await patchManifest(rulesets);

    await writeFile(path.join(OUT_DIR, 'SOURCES.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        chunkSize: chunk,
        withinBuild: 'Adult wins a domain that also appears in the ads list, so adult domains are never downgraded to a third-party-only block.',
        allowlist: ALLOWLIST,
        sources: provenance,
        rulesets: ruleResources,
        totals: { rules: totalRules, domains: totalDomains }
    }, null, 2) + '\n');

    console.log(`\ntotal ${totalRules} rules over ${totalDomains} domains (chunk ${chunk}/rule)`);
    console.log(`manifest rule_resources -> ${ruleResources.map((r) => r.id).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main().catch((e) => {
        console.error('build failed:', e.message);
        process.exit(1);
    });
}
