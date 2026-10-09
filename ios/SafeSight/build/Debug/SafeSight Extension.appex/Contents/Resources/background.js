// background.js (iOS / Safari)

// ---------------------------------------------------------------------------
// Inference engine
// ---------------------------------------------------------------------------
let readyModel = null;
let modelLoading = null;

async function initializeModel() {
    if (readyModel) return readyModel;
    if (modelLoading) return modelLoading;

    modelLoading = (async () => {
        try {
            console.log('[SafeSight] Initializing LiteRT model...');
            const mod = await import(chrome.runtime.getURL('litert.js'));
            console.log('[SafeSight] litert.js imported');
            
            // Use empty string to represent the root of the extension
            const litertInstance = await mod.loadLiteRt(chrome.runtime.getURL(''));
            console.log('[SafeSight] LiteRT instance loaded');
            
            readyModel = await litertInstance.loadAndCompile(chrome.runtime.getURL('nsfw.tflite'));
            console.log('[SafeSight] Model compiled and ready');
            return readyModel;
        } catch (e) {
            console.error('[SafeSight] Model initialization failed:', e);
            modelLoading = null;
            throw e;
        }
    })();

    try {
        return await modelLoading;
    } catch (e) {
        modelLoading = null;
        throw e;
    }
}

async function analyzePayload(payload) {
    const model = await initializeModel();

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

initializeModel().catch((e) => console.error('[SafeSight] Model pre-warm failed:', e));

setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { }); } catch (e) { }
}, 20000);

// ---------------------------------------------------------------------------
// App bridge (iOS)
// ---------------------------------------------------------------------------
const NATIVE_APP_ID = 'com.joshc.SafeSight';
const SHARED_SETTING_KEYS = ['skinFilter', 'blurAll', 'sensitivity', 'blocklistUser', 'accountEmail', 'accountName', 'accountReady', 'accountStatus', 'clientId', 'filtersEnabled', 'quietEnabled', 'quietStart', 'quietEnd'];
// Keys that together describe "which account is this device signed in as".
const ACCOUNT_KEYS = ['accountEmail', 'accountName', 'accountReady', 'accountStatus', 'clientId'];
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
        } catch (e) {
            finish(iosUserAgent);
        }
        setTimeout(() => finish(iosUserAgent), 300);
    });
}

function sendNative(message) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendNativeMessage(NATIVE_APP_ID, message, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('[SafeSight] Native bridge unavailable:', chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                resolve(response || null);
            });
        } catch (e) {
            console.warn('[SafeSight] Native bridge failed:', e);
            resolve(null);
        }
    });
}

async function applySettingsSnapshot(settings) {
    if (!settings) return false;
    const stored = await chrome.storage.local.get(SHARED_SETTING_KEYS);
    const appHasAccount = !!(settings.accountEmail && settings.accountName);
    const deviceHasAccount = !!(stored.accountReady || stored.accountEmail || stored.clientId);
    const patch = {};
    SHARED_SETTING_KEYS.forEach((key) => {
        if (!(key in settings)) return;
        // The native snapshot derives accountReady from the app's own sign-in,
        // so an app with no signed-in account reports an empty identity. An
        // empty snapshot must never wipe the account this device registered
        // through the extension's login page — that clobbering logged users
        // straight back out and stopped the content script filtering.
        if (!appHasAccount && deviceHasAccount && ACCOUNT_KEYS.includes(key)) return;
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

async function pushSettingsToApp(values) {
    if (!(await detectIOS())) return false;
    const res = await sendNative({ type: 'setSettings', values });
    if (!res || !res.ok) return false;
    await applySettingsSnapshot(res.settings);
    return true;
}

const stats = { scanned: 0, blocked: 0, dirty: false, flushTimer: null };

function bumpStats(blocked) {
    stats.scanned++;
    if (blocked) stats.blocked++;
    if (!stats.dirty) {
        stats.dirty = true;
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

    pushStatsToApp(next.scannedCount, next.blockedCount).catch(() => { });
}

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
    } catch (e) { }
    return false;
}

function blockedPageUrl(url, site, reason) {
    return chrome.runtime.getURL('blocked.html') +
        '?url=' + encodeURIComponent(url || '') +
        '&site=' + encodeURIComponent(site || '') +
        (reason ? '&reason=' + encodeURIComponent(reason) : '');
}

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

async function navigationDecision(url) {
    const res = await chrome.storage.local.get(['filtersEnabled', 'quietEnabled', 'quietStart', 'quietEnd']);
    if (res.filtersEnabled === false) return null;
    if (isQuietNow(res)) return 'quiet';
    return (await isUrlBlocked(url)) ? 'site' : null;
}

chrome.storage.onChanged.addListener((changes) => {
    if (BLOCKLIST_KEYS.some((key) => changes[key])) blocklistSetCache = null;
});

try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!changeInfo || changeInfo.status !== 'loading') return;
        const url = changeInfo.url || (tab && tab.url);
        if (!url || !/^https?:$/.test(url)) return;
        refreshSettingsIfStale().then(() => navigationDecision(url)).then((decision) => {
            if (!decision) return;
            let site = '';
            try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { }
            try {
                chrome.tabs.update(tabId, { url: blockedPageUrl(url, site, decision === 'quiet' ? 'quiet' : '') }, () => void chrome.runtime.lastError);
            } catch (e) { }
        }).catch(() => { });
    });
} catch (e) { }

try {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        const res = await chrome.storage.session.get(['disabledTabs']);
        const disabled = res.disabledTabs || {};
        if (disabled[tabId]) {
            delete disabled[tabId];
            await chrome.storage.session.set({ disabledTabs: disabled });
        }
    });
} catch (e) { }

seedBlocklistDefaults().catch(() => { });
syncFromApp().catch(() => { });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE') {
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
                console.error('[SafeSight] Analysis failed:', error);
                try {
                    await chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'AI_RESULT',
                        id: message.id,
                        score: 0
                    });
                } catch (e) { }
            }
        })();
        return true;
    }

    if (message.type === 'BLOCK_SITE_NAV') {
        if (sender.tab && typeof sender.tab.id === 'number') {
            try {
                chrome.tabs.update(sender.tab.id, { url: blockedPageUrl(message.url, message.site, message.reason) }, () => void chrome.runtime.lastError);
            } catch (e) { }
        }
        sendResponse({ ok: true });
        return;
    }

    if (message.type === 'FETCH_IMAGE') {
        handleFetchImage(message.url, sendResponse);
        return true;
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
            await chrome.storage.local.set(message.values || {});
            lastSyncAt = Date.now();
            sendResponse({ ok: true, native: false });
        })();
        return true;
    }
});
