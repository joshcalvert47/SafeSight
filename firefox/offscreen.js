import { loadLiteRt, Tensor } from './litert.js';

let readyModel = null;
let litertInstance = null;

async function initLiteRT() {
    if (litertInstance) return;
    try {
        litertInstance = await loadLiteRt('./');
        console.log("✅ Persistent LiteRT Library Loaded");
    } catch (e) {
        console.error("❌ Failed to load LiteRT:", e);
    }
}

async function initializeModel(url) {
    if (readyModel) return;
    try {
        console.log("🛠️ Initializing Persistent AI Engine...");
        await initLiteRT();
        readyModel = await litertInstance.loadAndCompile(url);
        console.log("🚀 Persistent AI Engine Ready - Model Loaded");
    } catch (e) {
        console.error("❌ Failed to initialize AI:", e);
        if (e.message && e.message.includes('CSP')) {
            console.error("💡 Hint: Ensure you have reloaded the extension to apply the new CSP policy.");
        }
    }
}

// Load the model once on startup
initializeModel('./nsfw.tflite');

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'OFFSCREEN_ANALYZE' && readyModel) {
        try {
            const { payload, id, tabId } = message;
            if (!payload || !payload.data || payload.data.length === 0) {
                throw new Error("Received empty image data payload.");
            }

            const inputData = new Uint8Array(payload.data);
            if (inputData.length !== 150528) {
                throw new Error(`Data size mismatch: Expected 150528, got ${inputData.length}`);
            }

            const inputDetails = readyModel.getInputDetails()[0];
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

            const outputs = await readyModel.run(inputTensor);
            const outputTensor = outputs[Object.keys(outputs)[0]];
            const results = await outputTensor.data();

            let score = 0;
            if (inputDetails.dtype !== 'float32' && results[0] > 1) {
                let total = 0;
                for (let i = 0; i < results.length; i++) total += results[i];
                const p_porn = results[3] / total;
                const p_hentai = results[1] / total;
                const p_sexy = results[4] / total;
                score = Math.round((p_porn + p_hentai) * 10);
                if (score < 4 && p_sexy > 0.3) score = Math.round(p_sexy * 10);
            } else {
                score = Math.round((results[3] + results[1]) * 10);
                if (score < 4 && results[4] > 0.3) score = Math.round(results[4] * 10);
            }

            // Send result back to service worker
            chrome.runtime.sendMessage({
                type: 'AI_RESULT_OFFSCREEN',
                id,
                tabId,
                score: Math.max(1, Math.min(10, score))
            });

            inputTensor.delete();
            for (const key in outputs) outputs[key].delete();

        } catch (e) {
            console.error("Offscreen Analysis Error:", e);
        }
    }
});
