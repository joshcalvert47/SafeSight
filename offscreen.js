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
            score = (porn + hentai + sexy) * 10;
            if (neutral > 0.85 && score < 2) score = 0;
            score = Math.max(0, Math.min(10, Math.round(score)));

            console.log('NSFW model output sample:', values.slice(0, 5), 'riskScore:', score);

            chrome.runtime.sendMessage({
                type: 'AI_RESULT_OFFSCREEN',
                id,
                tabId,
                score
            });

            inputTensor.delete();
            for (const key in outputs) outputs[key].delete();

        } catch (e) {
            console.error("Offscreen Analysis Error:", e);
        }
    }
});
