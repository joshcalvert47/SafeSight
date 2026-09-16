// content.js
let config = { showRatings: true, blurAll: false, sensitivity: 4 };
const requestMap = new Map();
let uniqueId = 0;

const styleId = 'ai-filter-styles';
function updateGlobalBlur() {
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        (document.head || document.documentElement).appendChild(styleEl);
    }

    const css = `
        img:not(.ai-safe):not([data-ai-checked="true"]),
        video:not(.ai-safe):not([data-ai-checked="true"]),
        canvas:not(.ai-safe):not([data-ai-checked="true"]),
        picture:not(.ai-safe):not([data-ai-checked="true"]),
        [style*="background"]:not(.ai-safe):not([data-ai-checked="true"]),
        [style*="url("]:not(.ai-safe):not([data-ai-checked="true"]) {
            filter: blur(75px) brightness(0.6) !important;
            transition: filter 0.5s ease-in-out !important;
            pointer-events: none !important;
        }

        ${config.blurAll ? `
            img, video, canvas, [style*="url("] { 
                filter: blur(90px) brightness(0.3) !important; 
            }
        ` : ""}

        .ai-flagged {
            filter: blur(80px) brightness(0.4) !important;
            pointer-events: none !important;
            cursor: not-allowed !important;
        }

        .ai-safe:not(.ai-flagged) {
            filter: none !important;
            pointer-events: auto !important;
        }
    `;

    if (styleEl.textContent !== css) styleEl.textContent = css;
}

function loadConfig() {
    chrome.storage.local.get(['showRatings', 'blurAll', 'sensitivity'], (res) => {
        config.showRatings = res.showRatings !== false;
        config.blurAll = !!res.blurAll;
        config.sensitivity = res.sensitivity ?? 4;
        updateGlobalBlur();
    });
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes.blurAll) config.blurAll = changes.blurAll.newValue;
    if (changes.showRatings) config.showRatings = changes.showRatings.newValue;
    if (changes.sensitivity) config.sensitivity = changes.sensitivity.newValue;
    updateGlobalBlur();
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AI_RESULT') {
        const { id, score } = message;
        const img = requestMap.get(id);

        chrome.storage.local.get(['scannedCount', 'blockedCount'], (res) => {
            let sCount = (res.scannedCount || 0) + 1;
            let bCount = (res.blockedCount || 0) + (score >= config.sensitivity ? 1 : 0);
            chrome.storage.local.set({ scannedCount: sCount, blockedCount: bCount });
        });

        if (img) {
            requestMap.delete(id);
            img.dataset.aiChecked = "true";
            if (config.showRatings) drawBadge(img, score);
            if (score >= config.sensitivity) {
                img.classList.add('ai-flagged');
                img.classList.remove('ai-safe');
            } else {
                img.classList.add('ai-safe');
                img.classList.remove('ai-flagged');
            }
        }
    }
});

function sendToBackground(img, id, rgbBytes) {
    chrome.runtime.sendMessage({
        type: 'ANALYZE',
        id,
        payload: {
            data: Array.from(rgbBytes)
        }
    });
}

function drawBadge(img, score) {
    const color = score >= 7 ? "#ff4444" : (score >= 4 ? "#ffbb33" : "#00C851");
    const container = (img.tagName === 'IMG') ? img.parentElement : img;
    if (!container) return;

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    const identifier = (img.src || img.getAttribute('data-src') || img.style.backgroundImage || "").slice(-15);
    let badge = container.querySelector(`.ai-badge[data-id="${identifier}"]`);
    if (!badge) {
        badge = document.createElement("div");
        badge.className = "ai-badge";
        badge.dataset.id = identifier;
        container.appendChild(badge);
    }
    badge.innerText = score;
    badge.style.cssText = `position:absolute; top:2px; right:2px; background:${color}; color:white; padding:2px 5px; border-radius:3px; font:bold 11px sans-serif; z-index:2147483647; pointer-events:none;`;
}

const scannedUrls = new Set();
const scanQueue = [];
let activeProcesses = 0;
const MAX_CONCURRENT = 3;
const sharedCanvas = new OffscreenCanvas(224, 224);
const sharedCtx = sharedCanvas.getContext("2d", { alpha: false, desynchronized: true, willReadFrequently: true });

const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            const img = entry.target;
            if (img.dataset.aiWaiting) {
                delete img.dataset.aiWaiting;
                processImageInternal(img);
            }
            intersectionObserver.unobserve(img);
        }
    }
}, { rootMargin: '400px' });

async function processImage(img) {
    if (!img || config.blurAll) return;

    let src = img.src || img.getAttribute('data-src');
    if (!src && img.style.backgroundImage) {
        src = img.style.backgroundImage.slice(4, -1).replace(/"/g, "");
    }
    if (!src && img.style.background) {
        const match = img.style.background.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (match) src = match[1];
    }

    if (src && (scannedUrls.has(src) || (src.startsWith('data:') && src.length < 500))) {
        img.classList.add('ai-safe');
        return;
    }

    img.classList.remove('ai-safe');
    img.dataset.aiWaiting = "true";

    if (src) scannedUrls.add(src);
    intersectionObserver.observe(img);
}

function processImageInternal(img) {
    if (activeProcesses < MAX_CONCURRENT) {
        runAnalysis(img);
    } else {
        scanQueue.push(img);
    }
}

async function runAnalysis(img) {
    activeProcesses++;
    try {
        const tImg = new Image();
        tImg.crossOrigin = "Anonymous";

        let src = img.src || img.getAttribute('data-src');
        if (!src && img.style.backgroundImage) {
            src = img.style.backgroundImage.slice(4, -1).replace(/"/g, "");
        }
        if (!src) throw new Error("No source");

        tImg.src = src;

        if (tImg.decode) {
            try { await tImg.decode(); } catch (e) { }
        } else {
            await new Promise((r, j) => { tImg.onload = r; tImg.onerror = j; setTimeout(j, 3000); });
        }

        sharedCtx.drawImage(tImg, 0, 0, 224, 224);
        const rgbaData = sharedCtx.getImageData(0, 0, 224, 224).data;

        const rgbData = new Uint8Array(224 * 224 * 3);
        for (let i = 0, j = 0; i < rgbaData.length; i += 4) {
            rgbData[j++] = rgbaData[i];
            rgbData[j++] = rgbaData[i + 1];
            rgbData[j++] = rgbaData[i + 2];
        }

        const id = uniqueId++;
        requestMap.set(id, img);
        sendToBackground(img, id, rgbData);

    } catch (e) {
        img.classList.add('ai-safe');
    } finally {
        activeProcesses--;
        if (scanQueue.length > 0) runAnalysis(scanQueue.shift());
    }
}

function start() {
    if (scannedUrls.size > 2000) scannedUrls.clear();
    document.querySelectorAll('img, canvas, [style*="background"], [style*="url("]').forEach(processImage);
}

loadConfig();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

const observer = new MutationObserver(m => {
    if (config.blurAll) return;
    for (const record of m) {
        if (record.type === 'childList') {
            record.addedNodes.forEach(node => {
                if (node.nodeType === 1) {
                    const tag = node.tagName;
                    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'PICTURE' || node.style?.background) processImage(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img, canvas, [style*="background"], [style*="url("]').forEach(processImage);
                    }
                }
            });
        } else if (record.type === 'attributes') {
            const target = record.target;
            if (target.nodeType === 1) {
                const attr = record.attributeName;
                if (attr === 'style' || attr === 'src' || attr === 'data-src') {
                    processImage(target);
                }
            }
        }
    }
});

observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'style', 'data-src']
});
