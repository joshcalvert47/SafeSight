// filter-manager.js — the network blocking lane.
//
// SafeSight blocks in three places. The ML image lane and the content-script
// site-blocklist lane both run *after* a page has started loading; this one is
// the network lane, where Chrome's declarativeNetRequest refuses the request
// before any page code (and, for adult/malware, before any bytes) move. It is
// also the only lane that works without an account, without a content script,
// and inside iframes and the excluded hosts.
//
// Loaded with importScripts() from service-worker.js (classic worker, so no
// module import needed and no manifest change).
//
// Rule id ranges (see tools/build-rulesets.mjs for the static rulesets):
//   static      1..N per ruleset   generated, never hand-edited
//   dynamic     1..19999           the user's own blocked sites
//   dynamic     20000..20099       "filtering is off on this site"
// Allow rules must outrank block/redirect rules or unbreaking a site silently
// fails, so every allow rule uses priority 1000 against blocks at 10 and
// redirects at 20.

const CATEGORY_RULESETS = ['adult', 'malware', 'ads'];
const DEFAULT_CATEGORIES = { adult: true, malware: true, ads: true };
const DEFAULT_CATEGORY_LABELS = {
    adult: 'Adult content',
    malware: 'Malware & phishing',
    ads: 'Ads & trackers'
};

const RULE_USER_BLOCK_MIN = 1;
const RULE_USER_BLOCK_MAX = 19999;
const RULE_SITE_ALLOW_MIN = 20000;
const RULE_SITE_ALLOW_MAX = 20099;
const PRIORITY_USER_BLOCK = 10;
const PRIORITY_SITE_ALLOW = 1000;

const USER_BLOCK_CHUNK = 1000; // domains per dynamic rule; mirrors the build chunk

function interstitialFor(category) {
    // The redirect target is a plain path; the attempted URL is carried in the
    // fragment last, because a query string would be mangled by the URL's own
    // '&' and '?'. blocked.html parses it back out.
    return `/blocked.html#category=${category}&url=`;
}

// ---------------------------------------------------------------------------
// Category switches
// ---------------------------------------------------------------------------
async function getCategories() {
    const res = await chrome.storage.local.get('filterCategories');
    return Object.assign({}, DEFAULT_CATEGORIES, res.filterCategories || {});
}

async function setCategory(id, enabled) {
    if (!CATEGORY_RULESETS.includes(id)) throw new Error('unknown filter category: ' + id);
    const categories = await getCategories();
    categories[id] = !!enabled;
    await chrome.storage.local.set({ filterCategories: categories });
    await applyCategoryRulesets(categories);
    return categories;
}

async function applyCategoryRulesets(categories) {
    const enableRulesetIds = [];
    const disableRulesetIds = [];
    for (const id of CATEGORY_RULESETS) {
        (categories[id] ? enableRulesetIds : disableRulesetIds).push(id);
    }
    try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
        return { ok: true };
    } catch (e) {
        // A ruleset that cannot be enabled is a real failure (usually the static
        // rule budget) — surface it instead of pretending filtering is on.
        return { ok: false, error: String(e && e.message || e) };
    }
}

/**
 * Chrome does not persist which static rulesets are enabled across an
 * extension update, so every start re-applies the user's stored choice. Without
 * this, filtering silently stops after a release.
 */
async function reconcileRulesets() {
    const categories = await getCategories();
    const result = await applyCategoryRulesets(categories);
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets().catch(() => []);
    const desired = CATEGORY_RULESETS.filter((id) => categories[id]);
    return { ok: result.ok, error: result.error || null, enabled, desired };
}

// ---------------------------------------------------------------------------
// User's own blocked sites -> dynamic rules
// ---------------------------------------------------------------------------
async function readUserSites() {
    const res = await chrome.storage.local.get('blocklistUser');
    return Array.isArray(res.blocklistUser) ? res.blocklistUser : [];
}

async function syncUserBlockRules() {
    const sites = await readUserSites();
    const rules = [];
    let id = RULE_USER_BLOCK_MIN;
    for (let i = 0; i < sites.length && id <= RULE_USER_BLOCK_MAX; i += USER_BLOCK_CHUNK) {
        const chunk = sites.slice(i, i + USER_BLOCK_CHUNK);
        rules.push({
            id: id++,
            priority: PRIORITY_USER_BLOCK,
            action: { type: 'block' },
            condition: {
                requestDomains: chunk,
                resourceTypes: ['main_frame', 'sub_frame']
            }
        });
        // Subresources too, so a site on the list cannot be embedded.
        rules.push({
            id: id++,
            priority: PRIORITY_USER_BLOCK,
            action: { type: 'block' },
            condition: {
                requestDomains: chunk,
                resourceTypes: ['stylesheet', 'script', 'image', 'font', 'media', 'object',
                    'xmlhttprequest', 'ping', 'csp_report', 'websocket', 'webtransport', 'other']
            }
        });
    }
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
        .filter((r) => r.id >= RULE_USER_BLOCK_MIN && r.id <= RULE_USER_BLOCK_MAX)
        .map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
    return rules.length;
}

// ---------------------------------------------------------------------------
// Per-site "filtering is off here" -> dynamic allow rules
// ---------------------------------------------------------------------------
async function getSitesOff() {
    const res = await chrome.storage.local.get('filterSiteOff');
    return Array.isArray(res.filterSiteOff) ? res.filterSiteOff : [];
}

async function syncSiteOffRules() {
    const sites = (await getSitesOff()).slice(0, RULE_SITE_ALLOW_MAX - RULE_SITE_ALLOW_MIN + 1);
    const rules = sites.map((host, i) => ({
        id: RULE_SITE_ALLOW_MIN + i,
        priority: PRIORITY_SITE_ALLOW,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
    }));
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
        .filter((r) => r.id >= RULE_SITE_ALLOW_MIN && r.id <= RULE_SITE_ALLOW_MAX)
        .map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
    return rules.length;
}

function normalizeHost(host) {
    if (!host || typeof host !== 'string') return null;
    const h = host.trim().toLowerCase().replace(/^\*\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return h.includes('.') ? h : null;
}

async function isSiteOff(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    const sites = await getSitesOff();
    return sites.some((s) => h === s || h.endsWith('.' + s));
}

async function setSiteOff(host, off) {
    const h = normalizeHost(host);
    if (!h) return { ok: false, error: 'invalid host' };
    let sites = await getSitesOff();
    sites = sites.filter((s) => s !== h);
    if (off) sites.push(h);
    await chrome.storage.local.set({ filterSiteOff: sites });
    const count = await syncSiteOffRules();
    return { ok: true, sites, rules: count };
}

// ---------------------------------------------------------------------------
// Toolbar badge counter
//
// setExtensionActionOptions(displayActionCountAsBadgeText) gives a per-tab
// blocked count with no extra permission and no declarativeNetRequestFeedback.
// That avoids a second, scarier permission warning for a cosmetic feature.
// ---------------------------------------------------------------------------
async function setupBadgeCounter() {
    try {
        await chrome.declarativeNetRequest.setExtensionActionOptions({
            displayActionCountAsBadgeText: true
        });
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Bring-up. Called on install, on startup, and once when the worker loads, so
// the state is right after any of: fresh install, browser restart, extension
// update, or a popup edit made while the worker was asleep.
// ---------------------------------------------------------------------------
async function initFilterManager({ force = false } = {}) {
    const out = { reconciled: null, userRules: 0, siteRules: 0, badge: false, errors: [] };
    try {
        out.reconciled = await reconcileRulesets();
        if (out.reconciled && out.reconciled.ok === false) out.errors.push('rulesets: ' + out.reconciled.error);
    } catch (e) { out.errors.push('rulesets: ' + e.message); }
    try { out.userRules = await syncUserBlockRules(); } catch (e) { out.errors.push('user rules: ' + e.message); }
    try { out.siteRules = await syncSiteOffRules(); } catch (e) { out.errors.push('site rules: ' + e.message); }
    out.badge = await setupBadgeCounter();
    return out;
}

// Re-sync whenever the popup (or the context menu) edits the lists.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.blocklistUser) syncUserBlockRules().catch(() => { });
    if (changes.filterSiteOff) syncSiteOffRules().catch(() => { });
});
