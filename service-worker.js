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

function hostFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

function hostMatchesSite(host, site) {
    return host === site || host.endsWith('.' + site);
}

async function setupContextMenus() {
    chrome.contextMenus.removeAll(() => {
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
