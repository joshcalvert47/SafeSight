// content.js
let config = { showRatings: true, skinFilter: false, blurAll: false, sensitivity: 4 };
const SKIN_COVERAGE_THRESHOLD = 0.12;
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
        /* Blur only until an image has been classified. */
        .ai-filter-target:not(.ai-safe):not([data-ai-checked="true"]) {
            filter: blur(75px) brightness(0.6) !important;
            transition: filter 0.5s ease-in-out !important;
            pointer-events: none !important; 
        }

        ${config.blurAll ? `
            img, video, canvas, [style*="url("] { 
                filter: blur(90px) brightness(0.3) !important; 
            }
        ` : ""}

        .ai-filter-target.ai-flagged {
            filter: blur(80px) brightness(0.4) !important;
            pointer-events: none !important;
            cursor: not-allowed !important;
        }

        .ai-filter-target.ai-safe:not(.ai-flagged) {
            filter: none !important;
            pointer-events: auto !important;
        }
    `;

    if (styleEl.textContent !== css) styleEl.textContent = css;
}

// 2. STORAGE SYNC
function loadConfig() {
    chrome.storage.local.get(['showRatings', 'skinFilter', 'blurAll', 'sensitivity'], (res) => {
        config.showRatings = res.showRatings !== false;
        config.skinFilter = !!res.skinFilter;
        config.blurAll = !!res.blurAll;
        config.sensitivity = res.sensitivity ?? 4;
        updateGlobalBlur();
    });
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes.blurAll) config.blurAll = changes.blurAll.newValue;
    if (changes.showRatings) config.showRatings = changes.showRatings.newValue;
    if (changes.skinFilter) config.skinFilter = changes.skinFilter.newValue;
    if (changes.sensitivity) config.sensitivity = changes.sensitivity.newValue;
    updateGlobalBlur();
});

// 3. RESULT HANDLING
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AI_RESULT') {
        const { id, score } = message;
        const request = requestMap.get(id);
        const img = request?.img;

        // Update Stats
        chrome.storage.local.get(['scannedCount', 'blockedCount'], (res) => {
            let sCount = (res.scannedCount || 0) + 1;
            let bCount = (res.blockedCount || 0) + (score >= config.sensitivity ? 1 : 0);
            chrome.storage.local.set({ scannedCount: sCount, blockedCount: bCount });
        });

        if (img) {
            requestMap.delete(id);
            img.dataset.aiChecked = "true";
            if (config.showRatings) drawBadge(img, score);
            if (config.skinFilter) showSkinOverlay(img, request?.skinOverlay);
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
            data: Array.from(rgbBytes) // Convert to standard Array for stable serialization
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

// 5. PIPELINE
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
    if (!img) return;

    // Mark the exact element being scanned; do not blur unrelated ancestors.
    img.classList.add('ai-filter-target');
    if (config.blurAll) return;

    // Check if it should be skipped
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

    // Force blur immediately via CSS (by ensuring .ai-safe is NOT present)
    img.classList.remove('ai-safe');
    img.dataset.aiWaiting = "true";

    if (src) scannedUrls.add(src);
    intersectionObserver.observe(img);
}

function createSkinOverlay(rgbaData) {
    let skinPixels = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let minX = 224;
    let minY = 224;
    let maxX = -1;
    let maxY = -1;
    const pixelCount = rgbaData.length / 4;
    const skinMask = new Uint8Array(pixelCount);

    for (let i = 0, pixel = 0; i < rgbaData.length; i += 4, pixel++) {
        const r = rgbaData[i];
        const g = rgbaData[i + 1];
        const b = rgbaData[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const brightness = (r + g + b) / 3;
        const total = r + g + b || 1;
        const redShare = r / total;
        const greenShare = g / total;
        const blueShare = b / total;
        // Relative chroma avoids rejecting darker skin because of low absolute RGB values.
        const isSkin = brightness > 8 && max - min > 4 &&
            redShare >= greenShare * 0.96 && greenShare >= blueShare * 0.96 &&
            redShare > blueShare * 1.04;

        if (isSkin) {
            const x = pixel % 224;
            const y = Math.floor(pixel / 224);
            skinMask[pixel] = 1;
            skinPixels++;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            red += r;
            green += g;
            blue += b;
        }
    }

    const coverage = pixelCount ? skinPixels / pixelCount : 0;
    if (!config.skinFilter || coverage < SKIN_COVERAGE_THRESHOLD) {
        return { coverage, canvas: null };
    }

    const overlay = document.createElement('canvas');
    overlay.width = 224;
    overlay.height = 224;
    const overlayCtx = overlay.getContext('2d');
    const overlayData = overlayCtx.createImageData(224, 224);
    const overlayRed = Math.round(red / skinPixels);
    const overlayGreen = Math.round(green / skinPixels);
    const overlayBlue = Math.round(blue / skinPixels);
    const paddingX = Math.max(2, Math.round((maxX - minX + 1) * 0.08));
    const paddingY = Math.max(2, Math.round((maxY - minY + 1) * 0.08));
    minX = Math.max(0, minX - paddingX);
    minY = Math.max(0, minY - paddingY);
    maxX = Math.min(223, maxX + paddingX);
    maxY = Math.min(223, maxY + paddingY);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const x = pixel % 224;
        const y = Math.floor(pixel / 224);
        const inDetectedRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
        if (!skinMask[pixel] && !inDetectedRegion) continue;
        const offset = pixel * 4;
        overlayData.data[offset] = overlayRed;
        overlayData.data[offset + 1] = overlayGreen;
        overlayData.data[offset + 2] = overlayBlue;
        overlayData.data[offset + 3] = 255;
    }

    overlayCtx.putImageData(overlayData, 0, 0);
    return { coverage, canvas: overlay };
}

function showSkinOverlay(img, overlay) {
    if (!overlay || !img.isConnected) return;

    const container = img.tagName === 'IMG' ? img.parentElement : img;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    const existing = container.querySelector('.ai-skin-overlay');
    if (existing) existing.remove();

    overlay.className = 'ai-skin-overlay';
    overlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:2147483646;';
    container.appendChild(overlay);
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
        const skinResult = createSkinOverlay(rgbaData);

        const rgbData = new Uint8Array(224 * 224 * 3);
        for (let i = 0, j = 0; i < rgbaData.length; i += 4) {
            rgbData[j++] = rgbaData[i];
            rgbData[j++] = rgbaData[i + 1];
            rgbData[j++] = rgbaData[i + 2];
        }

        const id = uniqueId++;
        requestMap.set(id, { img, skinOverlay: skinResult.canvas });
        sendToBackground(img, id, rgbData);

    } catch (e) {
        // Safe fallback
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
