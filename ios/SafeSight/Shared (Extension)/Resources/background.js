// background.js (iOS / Safari)
// Same logic as the Chrome build's service-worker.js, adapted for iOS:
//   - No chrome.offscreen and no MV3 service workers on iOS Safari, so the
//     LiteRT engine is loaded and run directly in this background page (the
//     same inline inference the Firefox build uses).
//   - No chrome.contextMenus, so the per-site context menu controls are not
//     available; storage is the single source of truth for site lists.
//   - The app owns every option on iOS (its Web Filter page writes the shared
//     App Group), so this page pulls those values down over
//     sendNativeMessage -> SafariWebExtensionHandler and mirrors them into
//     chrome.storage.local, which is what the content script reads. Counters go
//     the other way so the app's dashboard shows real numbers.
//   - iOS Safari unloads non-persistent background pages ~30s after extension
//     activity stops, forcing a full model reload on every wake; a cheap API
//     ping keeps the engine warm while Safari is running.

// ---------------------------------------------------------------------------
// Inference engine (replaces Chrome's offscreen document)
// ---------------------------------------------------------------------------
let readyModel = null;
let modelLoading = null;

async function initializeModel() {
    if (readyModel) return readyModel;
    if (modelLoading) return modelLoading;

    modelLoading = (async () => {
        const mod = await import(chrome.runtime.getURL('litert.js'));
        const litertInstance = await mod.loadLiteRt(chrome.runtime.getURL('./'));
        readyModel = await litertInstance.loadAndCompile(chrome.runtime.getURL('nsfw.tflite'));
        return readyModel;
    })();

    try {
        return await modelLoading;
    } catch (e) {
        // Allow a retry on the next request instead of caching the failure.
        modelLoading = null;
        throw e;
    }
}

async function analyzePayload(payload) {
    const model = await initializeModel();

    // payload.data arrives as a plain array (JSON-only extension messaging).
    const inputData = new Uint8Array(payload.data);
    if (inputData.length !== 150528) {
        throw new Error(`Data size mismatch: Expected 150528, got ${inputData.length}`);
    }

    const { Tensor } = await import(chrome.runtime.getURL('litert.js'));

    const inputDetails = model.getInputDetails()[0];
    let inputTensor;

    if (inputDetails.dtype === 'float32') {
        const floatData = new Float32Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            floatData[i] = inputData[i] / 255.0;
        }
        inputTensor = Tensor.fromTypedArray(floatData, [1, 224, 224, 3]);
    } else {
        inputTensor = Tensor.fromTypedArray(inputData, [1, 224, 224, 3]);
    }

    const outputs = await model.run(inputTensor);
    const outputTensor = outputs[Object.keys(outputs)[0]];
    const results = await outputTensor.data();

    const values = Array.from(results).map(Number);
    const hasLargeValues = values.some(v => v > 1);
    let probs = values;
    if (hasLargeValues) {
        const total = values.reduce((sum, v) => sum + v, 0) || 1;
        probs = values.map(v => v / total);
    }

    const porn = probs[3] || 0;
    const hentai = probs[1] || 0;
    const sexy = probs[4] || 0;
    const neutral = probs[2] || 0;

    let score = (porn + hentai + sexy) * 10;
    if (neutral > 0.85 && score < 2) score = 0;
    const finalScore = Math.max(0, Math.min(10, Math.round(score)));

    inputTensor.delete();
    for (const key in outputs) outputs[key].delete();
    return finalScore;
}

// Pre-warm: start loading the model the moment the background page wakes, so
// the first ANALYZE doesn't pay the whole cold start inside its own deadline.
initializeModel().catch((e) => console.error('SafeSight model pre-warm failed:', e));

// Keep-alive ping (see header comment).
setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { }); } catch (e) { /* unloaded */ }
}, 20000);

// ---------------------------------------------------------------------------
// App bridge (iOS)
// ---------------------------------------------------------------------------
const NATIVE_APP_ID = 'com.joshc.SafeSight';
const SHARED_SETTING_KEYS = ['skinFilter', 'blurAll', 'sensitivity', 'blocklistUser', 'accountEmail', 'accountName', 'accountReady', 'accountStatus', 'clientId', 'filtersEnabled', 'quietEnabled', 'quietStart', 'quietEnd'];
const SYNC_MAX_AGE_MS = 10000;

let isIOS = null;
let lastSyncAt = 0;
let syncInFlight = null;
let lastPushedStats = null;

function detectIOS() {
    if (isIOS !== null) return Promise.resolve(isIOS);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            isIOS = value;
            resolve(value);
        };
        const iosUserAgent = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
        try {
            chrome.runtime.getPlatformInfo((info) => {
                const platform = String(info?.os || '').toLowerCase();
                finish(iosUserAgent || platform === 'ios');
            });
        } catch (e) { finish(iosUserAgent); }
        setTimeout(() => finish(iosUserAgent), 300);
    });
}

function sendNative(message) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendNativeMessage(NATIVE_APP_ID, message, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('SafeSight native bridge unavailable:', chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                resolve(response || null);
            });
        } catch (e) {
            console.warn('SafeSight native bridge failed:', e);
            resolve(null);
        }
    });
}

/// Copies the app's settings into storage, writing only what actually changed.
async function applySettingsSnapshot(settings) {
    if (!settings) return false;
    const stored = await chrome.storage.local.get(SHARED_SETTING_KEYS);
    const patch = {};
    SHARED_SETTING_KEYS.forEach((key) => {
        if (!(key in settings)) return;
        if (JSON.stringify(stored[key]) !== JSON.stringify(settings[key])) patch[key] = settings[key];
    });
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    lastSyncAt = Date.now();
    return true;
}

async function syncFromApp() {
    if (!(await detectIOS())) return null;
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
        const settings = (await sendNative({ type: 'getSettings' }))?.settings;
        if (!settings) return null;
        await applySettingsSnapshot(settings);
        return settings;
    })();
    try {
        return await syncInFlight;
    } finally {
        syncInFlight = null;
    }
}

/// Cheap gate so navigations don't each pay for a native round-trip.
async function refreshSettingsIfStale(maxAgeMs = SYNC_MAX_AGE_MS) {
    if (Date.now() - lastSyncAt < maxAgeMs) return true;
    return syncFromApp();
}

async function pushStatsToApp(scannedCount, blockedCount) {
    if (!(await detectIOS())) return false;
    if (lastPushedStats && lastPushedStats[0] === scannedCount && lastPushedStats[1] === blockedCount) return true;
    const res = await sendNative({ type: 'setStats', values: { scannedCount, blockedCount } });
    if (res && res.ok) {
        lastPushedStats = [scannedCount, blockedCount];
        return true;
    }
    return false;
}

/// Used by the popup when it edits settings. Returns false when there is no
/// app to write to, so the caller can fall back to local storage.
async function pushSettingsToApp(values) {
    if (!(await detectIOS())) return false;
    const res = await sendNative({ type: 'setSettings', values });
    if (!res || !res.ok) return false;
    await applySettingsSnapshot(res.settings);
    return true;
}

// ---------------------------------------------------------------------------
// Stats aggregation (same scheme as the Chrome build)
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
    const next = {
        scannedCount: (res.scannedCount || 0) + stats.scanned,
        blockedCount: (res.blockedCount || 0) + stats.blocked
    };
    await chrome.storage.local.set(next);
    stats.scanned = 0;
    stats.blocked = 0;
    stats.dirty = false;

    // Mirror the totals into the app group so the app's dashboard is real.
    pushStatsToApp(next.scannedCount, next.blockedCount).catch(() => { });
}

// ---------------------------------------------------------------------------
// CORS-free image proxy (same as the Chrome build)
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
// Site blocklist — hard navigation block (same as the Chrome build)
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

function blockedPageUrl(url, site, reason) {
    return chrome.runtime.getURL('blocked.html') +
        '?url=' + encodeURIComponent(url || '') +
        '&site=' + encodeURIComponent(site || '') +
        (reason ? '&reason=' + encodeURIComponent(reason) : '');
}

// ---------------------------------------------------------------------------
// Quiet hours — mirrors SharedSettings.isDuringQuietHours (HH:mm strings,
// local clock, window may wrap midnight).
// ---------------------------------------------------------------------------
function parseHM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

function isQuietNow(settings) {
    if (!settings || !settings.quietEnabled) return false;
    const s = parseHM(settings.quietStart);
    const e = parseHM(settings.quietEnd);
    if (s === null || e === null || s === e) return false;
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    return s < e ? (current >= s && current < e) : (current >= s || current < e);
}

// Decides what happens to a navigation: null = allow, 'quiet' = quiet-hours
// block, 'site' = block-list hit. Filters paused (filtersEnabled false) means
// everything is allowed.
async function navigationDecision(url) {
    const res = await chrome.storage.local.get(['filtersEnabled', 'quietEnabled', 'quietStart', 'quietEnd']);
    if (res.filtersEnabled === false) return null;
    if (isQuietNow(res)) return 'quiet';
    return (await isUrlBlocked(url)) ? 'site' : null;
}

chrome.storage.onChanged.addListener((changes) => {
    if (BLOCKLIST_KEYS.some((key) => changes[key])) blocklistSetCache = null;
});

// Enforce at navigation start — also covers hosts where the content script
// does not run (e.g. the excluded-host wrapper). Guarded: Safari's tabs API
// surface is smaller.
try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!changeInfo || changeInfo.status !== 'loading') return;
        const url = changeInfo.url || (tab && tab.url);
        if (!url || !/^https?:/.test(url)) return;
        // Pick up any change the user made in the app before we decide.
        refreshSettingsIfStale().then(() => navigationDecision(url)).then((decision) => {
            if (!decision) return;
            let site = '';
            try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { }
            try {
                chrome.tabs.update(tabId, { url: blockedPageUrl(url, site, decision === 'quiet' ? 'quiet' : '') }, () => void chrome.runtime.lastError);
            } catch (e) { /* tabs API unavailable */ }
        }).catch(() => { });
    });
} catch (e) { /* tabs.onUpdated unavailable */ }

// Clear per-tab disables when tabs close (no-op here, kept for parity).
try {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        const res = await chrome.storage.session.get(['disabledTabs']);
        const disabled = res.disabledTabs || {};
        if (disabled[tabId]) {
            delete disabled[tabId];
            await chrome.storage.session.set({ disabledTabs: disabled });
        }
    });
} catch (e) { /* tabs API unavailable */ }

// Refresh cached defaults from blocklist.json (compare-guarded write).
seedBlocklistDefaults().catch(() => { });

// Pull the app's settings down as soon as the background page wakes.
syncFromApp().catch(() => { });

// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE') {
        // Only accept requests from real tabs with a known id.
        if (!sender.tab || typeof sender.tab.id !== 'number' || typeof message.id !== 'number') {
            return;
        }
        (async () => {
            try {
                const score = await analyzePayload(message.payload);
                await chrome.tabs.sendMessage(sender.tab.id, {
                    type: 'AI_RESULT',
                    id: message.id,
                    score
                });
            } catch (error) {
                console.error('SafeSight analysis failed:', error);
                try {
                    await chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'AI_RESULT',
                        id: message.id,
                        score: 0
                    });
                } catch (e) { /* tab closed */ }
            }
        })();
        return true; // Keep channel open
    }

    if (message.type === 'BLOCK_SITE_NAV') {
        // The content script found this tab's host on the block list. Navigate
        // it ourselves: extension-initiated navigation is allowed in every
        // browser (page-initiated jumps to extension pages are not).
        if (sender.tab && typeof sender.tab.id === 'number') {
            try {
                chrome.tabs.update(sender.tab.id, { url: blockedPageUrl(message.url, message.site, message.reason) }, () => void chrome.runtime.lastError);
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
        lastPushedStats = null;
        pushStatsToApp(0, 0).catch(() => { });
        return;
    }

    if (message.type === 'SYNC_FROM_APP') {
        // The popup and content script use the same fresh snapshot.
        syncFromApp().then((settings) => sendResponse({
            ok: !!settings,
            settings: settings || undefined
        }));
        return true;
    }

    if (message.type === 'PUSH_SETTINGS') {
        (async () => {
            const native = await pushSettingsToApp(message.values || {});
            if (native) {
                sendResponse({ ok: true, native: true });
                return;
            }
            // No app to talk to: storage stays the source of truth.
            await chrome.storage.local.set(message.values || {});
            lastSyncAt = Date.now();
            sendResponse({ ok: true, native: false });
        })();
        return true;
    }
});
