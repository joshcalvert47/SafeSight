// service-worker.js
importScripts(chrome.runtime.getURL('litert.js'));

let readyModel = null;
let litertInstance = null;
let modelLoading = null;

async function initializeModel() {
    if (readyModel) return readyModel;
    if (modelLoading) return modelLoading;

    modelLoading = (async () => {
        litertInstance = await loadLiteRt(chrome.runtime.getURL('./'));
        readyModel = await litertInstance.loadAndCompile(chrome.runtime.getURL('nsfw.tflite'));
        return readyModel;
    })();

    return modelLoading;
}

async function analyzePayload(payload) {
    const model = await initializeModel();

    const inputData = new Uint8Array(payload.data);
    if (inputData.length !== 150528) {
        throw new Error(`Data size mismatch: Expected 150528, got ${inputData.length}`);
    }

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

    console.log('NSFW model output sample:', values.slice(0, 5), 'riskScore:', finalScore);

    inputTensor.delete();
    for (const key in outputs) outputs[key].delete();
    return finalScore;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE') {
        (async () => {
            try {
                const score = await analyzePayload(message.payload);
                if (sender && sender.tab && sender.tab.id) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'AI_RESULT',
                        id: message.id,
                        score
                    });
                }
            } catch (error) {
                console.error('Firefox SafeSight analysis failed:', error);
                if (sender && sender.tab && sender.tab.id) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'AI_RESULT',
                        id: message.id,
                        score: 0
                    });
                }
            }
        })();
        return true;
    }
});
