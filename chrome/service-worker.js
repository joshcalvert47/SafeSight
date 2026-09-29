// service-worker.js
let creating; // A global promise to avoid race conditions

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
async function setupOffscreen() {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) return;

    if (creating) {
        await creating;
    } else {
        creating = chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ['DOM_PARSER'], // Closest reason for WASM/Canvas usage
            justification: 'AI Image Inference using LiteRT',
        });
        await creating;
        creating = null;
    }
}

// Ensure offscreen doc is ready on start
chrome.runtime.onStartup.addListener(setupOffscreen);
chrome.runtime.onInstalled.addListener(() => {
    setupOffscreen();
    setupContextMenus();
});

// ---------------------------------------------------------------------------
// Stats aggregation
// Each tab used to do read-modify-write on storage.local, losing counts under
// concurrency. Tabs now send BUMP_STATS and this worker owns the counters,
// buffering writes so storage is touched at most every few seconds.
// ---------------------------------------------------------------------------
const stats = { scanned: 0, blocked: 0, dirty: false, flushTimer: null };

function bumpStats(blocked) {
    stats.scanned++;
    if (blocked) stats.blocked++;
    if (!stats.dirty) {
        stats.dirty = true;
        // Coalesce bursts into a single storage write.
        stats.flushTimer = setTimeout(flushStats, 3000);
    }
}

async function flushStats() {
    if (stats.flushTimer) clearTimeout(stats.flushTimer);
    stats.flushTimer = null;
    if (!stats.dirty) return;

    const res = await chrome.storage.local.get(['scannedCount', 'blockedCount']);
    await chrome.storage.local.set({
        scannedCount: (res.scannedCount || 0) + stats.scanned,
        blockedCount: (res.blockedCount || 0) + stats.blocked
    });
    stats.scanned = 0;
    stats.blocked = 0;
    stats.dirty = false;
}

// ---------------------------------------------------------------------------
// CORS-free image proxy
// Content scripts cannot read pixels of cross-origin images without CORS
// headers. The worker has <all_urls> host permissions, so it can fetch and
// hand back the raw bytes. NOTE: extension messaging is JSON-only in Chrome,
// so this must be a plain Array, not a typed array.
// ---------------------------------------------------------------------------
async function handleFetchImage(url, sendResponse) {
    try {
        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const mime = resp.headers.get('content-type') || 'image/png';
        const buf = new Uint8Array(await resp.arrayBuffer());
        sendResponse({ ok: true, bytes: Array.from(buf), mime });
    } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
    }
}

// ---------------------------------------------------------------------------
// Context menus: per-site controls
// ---------------------------------------------------------------------------
const MENU_ALLOW = 'safesight-allow-site';
const MENU_BLOCK = 'safesight-block-site';
const MENU_TOGGLE = 'safesight-toggle-site';
const MENU_NAV_BLOCK = 'safesight-nav-block-site';

function hostFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

function hostMatchesSite(host, site) {
    return host === site || host.endsWith('.' + site);
}

async function setupContextMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: MENU_NAV_BLOCK,
            title: 'SafeSight: Toggle blocking this site',
            contexts: ['all']
        });
        chrome.contextMenus.create({
            id: MENU_ALLOW,
            title: 'SafeSight: Always allow this site',
            contexts: ['all']
        });
        chrome.contextMenus.create({
            id: MENU_BLOCK,
            title: 'SafeSight: Always filter this site',
            contexts: ['all']
        });
        chrome.contextMenus.create({
            id: MENU_TOGGLE,
            title: 'SafeSight: Disable filtering on this tab',
            contexts: ['all']
        });
    });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id === undefined) return;
    const host = hostFromUrl(info.pageUrl || tab.url);
    if (!host) return;

    if (info.menuItemId === MENU_ALLOW || info.menuItemId === MENU_BLOCK) {
        const key = info.menuItemId === MENU_ALLOW ? 'allowedSites' : 'blockedSites';
        const res = await chrome.storage.local.get(key);
        const list = Array.isArray(res[key]) ? res[key] : [];
        if (!list.includes(host)) list.push(host);
        // A site can't be in both lists.
        const other = info.menuItemId === MENU_ALLOW ? 'blockedSites' : 'allowedSites';
        const otherRes = await chrome.storage.local.get(other);
        const otherList = (otherRes[other] || []).filter((s) => !hostMatchesSite(host, s));
        await chrome.storage.local.set({ [key]: list, [other]: otherList });
        // Reload so the content script picks a clean state.
        chrome.tabs.reload(tab.id);
    }

    if (info.menuItemId === MENU_TOGGLE) {
        const res = await chrome.storage.session.get(['disabledTabs']);
        const disabled = res.disabledTabs || {};
        const nowDisabled = !disabled[tab.id];
        if (nowDisabled) disabled[tab.id] = true;
        else delete disabled[tab.id];
        await chrome.storage.session.set({ disabledTabs: disabled });

        chrome.contextMenus.update(MENU_TOGGLE, {
            title: nowDisabled ? 'SafeSight: Enable filtering on this tab' : 'SafeSight: Disable filtering on this tab'
        });
        chrome.tabs.sendMessage(tab.id, { type: 'SITE_TOGGLE', enabled: !nowDisabled }).catch(() => { });
        if (!nowDisabled) chrome.tabs.sendMessage(tab.id, { type: 'RESCAN_PAGE' }).catch(() => { });
    }

    if (info.menuItemId === MENU_NAV_BLOCK) {
        // host was derived above; toggle hard-blocking for this site.
        const res = await chrome.storage.local.get(BLOCKLIST_KEYS);
        const defaults = Array.isArray(res.blocklistDefaults) ? res.blocklistDefaults : await loadDefaultBlocklistFile();
        const user = Array.isArray(res.blocklistUser) ? res.blocklistUser : [];
        const removed = Array.isArray(res.blocklistRemoved) ? res.blocklistRemoved : [];
        const currentlyBlocked = await isUrlBlocked(info.pageUrl || tab.url || '');
        const keptUser = user.filter((s) => !hostMatchesSite(host, s));
        const keptRemoved = removed.filter((s) => !hostMatchesSite(host, s));
        if (currentlyBlocked) {
            // Unblock: drop the user entry; if it is a shipped default, remember the removal.
            if (defaults.some((s) => hostMatchesSite(host, s))) keptRemoved.push(host);
        } else {
            // Block: add to the user list (and undo any earlier removal).
            keptUser.push(host);
        }
        await chrome.storage.local.set({ blocklistUser: keptUser, blocklistRemoved: keptRemoved });
        chrome.tabs.reload(tab.id);
    }
});

// Clear per-tab disables when tabs close.
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const res = await chrome.storage.session.get(['disabledTabs']);
    const disabled = res.disabledTabs || {};
    if (disabled[tabId]) {
        delete disabled[tabId];
        await chrome.storage.session.set({ disabledTabs: disabled });
    }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Site blocklist — hard navigation block.
// Defaults ship in blocklist.json (refreshed into storage on wake); user edits
// live in blocklistUser / blocklistRemoved. A host matches a list entry exactly
// or as a subdomain (sub.example.com matches example.com).
// ---------------------------------------------------------------------------
const BLOCKLIST_KEYS = ['blocklistDefaults', 'blocklistUser', 'blocklistRemoved'];
let blocklistSetCache = null;

function normalizeSite(entry) {
    if (typeof entry !== 'string') return null;
    let s = entry.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[\/?#]/)[0];
    s = s.split('@').pop().split(':')[0];
    s = s.replace(/^\*\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return s.includes('.') ? s : null;
}

async function loadDefaultBlocklistFile() {
    try {
        const resp = await fetch(chrome.runtime.getURL('blocklist.json'));
        const data = await resp.json();
        const list = Array.isArray(data) ? data : ((data && data.sites) || []);
        const sites = [];
        list.forEach((entry) => {
            const s = normalizeSite(entry);
            if (s && !sites.includes(s)) sites.push(s);
        });
        return sites;
    } catch (e) {
        return [];
    }
}

async function seedBlocklistDefaults() {
    const sites = await loadDefaultBlocklistFile();
    if (!sites.length) return;
    const res = await chrome.storage.local.get(['blocklistDefaults']);
    if (JSON.stringify(res.blocklistDefaults || []) !== JSON.stringify(sites)) {
        await chrome.storage.local.set({ blocklistDefaults: sites });
    }
}

async function getEffectiveBlocklist() {
    if (blocklistSetCache) return blocklistSetCache;
    const res = await chrome.storage.local.get(BLOCKLIST_KEYS);
    const defaults = Array.isArray(res.blocklistDefaults) ? res.blocklistDefaults : await loadDefaultBlocklistFile();
    const removed = new Set(Array.isArray(res.blocklistRemoved) ? res.blocklistRemoved : []);
    const user = Array.isArray(res.blocklistUser) ? res.blocklistUser : [];
    blocklistSetCache = new Set([...defaults.filter((s) => !removed.has(s)), ...user]);
    return blocklistSetCache;
}

async function isUrlBlocked(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.replace(/^www\./, '');
        const list = await getEffectiveBlocklist();
        for (const site of list) {
            if (host === site || host.endsWith('.' + site)) return true;
        }
    } catch (e) { /* invalid URL */ }
    return false;
}

function blockedPageUrl(url, site) {
    return chrome.runtime.getURL('blocked.html') +
        '?url=' + encodeURIComponent(url || '') +
        '&site=' + encodeURIComponent(site || '');
}

chrome.storage.onChanged.addListener((changes) => {
    if (BLOCKLIST_KEYS.some((key) => changes[key])) blocklistSetCache = null;
});

// Enforce at navigation start — also covers hosts where the content script
// does not run (e.g. manifest exclude_matches).
try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!changeInfo || changeInfo.status !== 'loading') return;
        const url = changeInfo.url || (tab && tab.url);
        if (!url || !/^https?:/.test(url)) return;
        isUrlBlocked(url).then((blocked) => {
            if (!blocked) return;
            let site = '';
            try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { }
            try {
                chrome.tabs.update(tabId, { url: blockedPageUrl(url, site) }, () => void chrome.runtime.lastError);
            } catch (e) { /* tabs API unavailable */ }
        }).catch(() => { });
    });
} catch (e) { /* tabs.onUpdated unavailable */ }

// Refresh cached defaults from blocklist.json (compare-guarded write).
seedBlocklistDefaults().catch(() => { });

// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE') {
        // Only accept requests from real tabs with a known id.
        if (!sender.tab || typeof sender.tab.id !== 'number' || typeof message.id !== 'number') {
            return;
        }
        (async () => {
            await setupOffscreen();
            // Send to offscreen document
            chrome.runtime.sendMessage({
                type: 'OFFSCREEN_ANALYZE',
                payload: message.payload,
                id: message.id,
                tabId: sender.tab.id
            });
        })();
        return true; // Keep channel open
    }

    // Handle result coming back from Offscreen
    if (message.type === 'AI_RESULT_OFFSCREEN') {
        if (typeof message.tabId === 'number') {
            chrome.tabs.sendMessage(message.tabId, {
                type: 'AI_RESULT',
                id: message.id,
                score: message.score
            }).catch(() => { });
        }
        return;
    }

    if (message.type === 'BLOCK_SITE_NAV') {
        // The content script found this tab's host on the block list. Navigate
        // it ourselves: extension-initiated navigation is allowed in every
        // browser (page-initiated jumps to extension pages are not).
        if (sender.tab && typeof sender.tab.id === 'number') {
            try {
                chrome.tabs.update(sender.tab.id, { url: blockedPageUrl(message.url, message.site) }, () => void chrome.runtime.lastError);
            } catch (e) { /* tabs API unavailable */ }
        }
        sendResponse({ ok: true });
        return;
    }

    if (message.type === 'FETCH_IMAGE') {
        handleFetchImage(message.url, sendResponse);
        return true; // async sendResponse
    }

    if (message.type === 'BUMP_STATS') {
        bumpStats(!!message.blocked);
        return;
    }

    if (message.type === 'RESET_STATS') {
        stats.scanned = 0;
        stats.blocked = 0;
        stats.dirty = false;
        if (stats.flushTimer) clearTimeout(stats.flushTimer);
        stats.flushTimer = null;
        chrome.storage.local.set({ scannedCount: 0, blockedCount: 0 });
        return;
    }
});
