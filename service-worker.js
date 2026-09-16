// service-worker.js
let creating; // A global promise to avoid race conditions

function computeRiskScore(results) {
    const values = Array.from(results).map(Number);
    if (values.length < 5) return 0;

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

    return Math.max(0, Math.min(10, Math.round(score)));
}

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
chrome.runtime.onInstalled.addListener(setupOffscreen);

// Relay messages from Content Script to Offscreen Document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE') {
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
        chrome.tabs.sendMessage(message.tabId, {
            type: 'AI_RESULT',
            id: message.id,
            score: message.score
        });
    }
});
