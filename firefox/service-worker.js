// service-worker.js (Firefox)
// Firefox MV3 has no chrome.offscreen and background service workers are not
// supported, so inference runs directly in the background event page. The
// LiteRT bundle is an ES module, which importScripts() cannot load — use a
// dynamic import() instead (supported in Firefox background pages).
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

    // payload.data arrives as a plain array; Firefox structured-clone would
    // also carry typed arrays, but keep both builds identical.
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

// ---------------------------------------------------------------------------
// Stats aggregation (same scheme as the Chrome build)
// ---------------------------------------------------------------------------
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
    await chrome.storage.local.set({
        scannedCount: (res.scannedCount || 0) + stats.scanned,
        blockedCount: (res.blockedCount || 0) + stats.blocked
    });
    stats.scanned = 0;
    stats.blocked = 0;
    stats.dirty = false;
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
// Message router
// ---------------------------------------------------------------------------
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
        return true;
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
