// content.js
let config = { showRatings: true, skinFilter: false, blurAll: false, sensitivity: 4, blockedSites: [], allowedSites: [] };
const SKIN_COVERAGE_THRESHOLD = 0.12;
const SCAN_TIMEOUT_MS = 5000; // Reveal if no verdict within 5s of the blur starting.
const requestMap = new Map();
const pendingBySrc = new Map(); // src -> imgs waiting on the same in-flight request
let uniqueId = 0;
let siteFilteringEnabled = true; // Per-site master toggle from the context menu / popup.

function currentSiteHost() {
    try { return location.hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function hostMatchesSite(host, site) {
    return host === site || host.endsWith('.' + site);
}

function isSiteAllowed() {
    const host = currentSiteHost();
    return config.allowedSites.some((site) => hostMatchesSite(host, site));
}

function isSiteBlocked() {
    const host = currentSiteHost();
    return config.blockedSites.some((site) => hostMatchesSite(host, site));
}

// 1. GLOBAL BLUR STYLES
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
    chrome.storage.local.get(['showRatings', 'skinFilter', 'blurAll', 'sensitivity', 'blockedSites', 'allowedSites'], (res) => {
        config.showRatings = res.showRatings !== false;
        config.skinFilter = !!res.skinFilter;
        config.blurAll = !!res.blurAll;
        config.sensitivity = res.sensitivity ?? 4;
        config.blockedSites = Array.isArray(res.blockedSites) ? res.blockedSites : [];
        config.allowedSites = Array.isArray(res.allowedSites) ? res.allowedSites : [];
        siteFilteringEnabled = !isSiteBlocked() || isSiteAllowed();
        updateGlobalBlur();
    });
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes.blurAll) config.blurAll = changes.blurAll.newValue;
    if (changes.showRatings) config.showRatings = changes.showRatings.newValue;
    if (changes.skinFilter) config.skinFilter = changes.skinFilter.newValue;
    if (changes.sensitivity) config.sensitivity = changes.sensitivity.newValue;
    if (changes.blockedSites) config.blockedSites = Array.isArray(changes.blockedSites.newValue) ? changes.blockedSites.newValue : [];
    if (changes.allowedSites) config.allowedSites = Array.isArray(changes.allowedSites.newValue) ? changes.allowedSites.newValue : [];
    siteFilteringEnabled = !isSiteBlocked() || isSiteAllowed();
    updateGlobalBlur();
});

// 3. RESULT HANDLING
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AI_RESULT') {
        const { id, score } = message;
        const request = requestMap.get(id);
        const img = request?.img;
        const timeout = request?.timeoutId;
        if (timeout) { clearTimeout(timeout); if (img) img.__aiTimer = null; }

        // Update Stats (throttled; the service worker owns the persisted values)
        chrome.runtime.sendMessage({
            type: 'BUMP_STATS',
            blocked: Number(score) >= config.sensitivity
        });

        if (img) {
            requestMap.delete(id);
            if (request.src) {
                cacheVerdict(request.src, Number(score));
                // Apply the verdict to every duplicate of this image that was
                // waiting on the same request (avatars, repeated thumbs).
                const waiting = pendingBySrc.get(request.src);
                if (waiting) {
                    pendingBySrc.delete(request.src);
                    waiting.forEach((other) => {
                        if (other !== img && other.isConnected) applyVerdict(other, score);
                    });
                }
            }
            applyVerdict(img, score, request.skinOverlay);
        }
        return;
    }

    if (message.type === 'SITE_TOGGLE') {
        // Live switch of filtering for this tab (context menu "Disable on this site").
        siteFilteringEnabled = message.enabled;
        if (siteFilteringEnabled) {
            start();
        } else {
            // Un-blur everything that was flagged or pending in this tab.
            document.querySelectorAll('.ai-filter-target').forEach((el) => {
                el.classList.remove('ai-flagged', 'ai-safe', 'ai-filter-target');
            });
        }
        updateGlobalBlur();
        return;
    }

    if (message.type === 'RESCAN_PAGE') {
        start();
    }
});

function applyVerdict(img, score, skinOverlay) {
    if (img.__aiTimer) { clearTimeout(img.__aiTimer); img.__aiTimer = null; }
    img.classList.add('ai-filter-target'); // ensure the verdict CSS applies
    img.dataset.aiChecked = "true";
    if (config.showRatings) drawBadge(img, score);
    if (config.skinFilter) showSkinOverlay(img, skinOverlay);

    if (Number(score) >= config.sensitivity) {
        img.classList.add('ai-flagged');
        img.classList.remove('ai-safe');
        // Admin reveal: click a flagged image to unblur just that one.
        img.addEventListener('click', onAdminReveal, { once: true, capture: true });
    } else {
        img.classList.add('ai-safe');
        img.classList.remove('ai-flagged');
    }
}

// Admin-only click-to-reveal (requires adminUnlocked in storage).
function onAdminReveal(event) {
    event.preventDefault();
    event.stopPropagation();
    chrome.storage.local.get(['adminUnlocked'], (res) => {
        const img = event.currentTarget;
        if (res.adminUnlocked) {
            img.classList.add('ai-safe');
            img.classList.remove('ai-flagged');
        }
        img.removeEventListener('click', onAdminReveal, { capture: true });
    });
}

// 4. IMAGE ACQUISITION
// Try a direct canvas read first; if the image is cross-origin without CORS,
// ask the service worker to fetch it (host_permissions bypass CORS there).
async function extractPixels(img) {
    const tImg = new Image();
    tImg.crossOrigin = "Anonymous";

    const src = getSource(img);
    if (!src) throw new Error("No source");

    tImg.src = src;
    if (tImg.decode) {
        try { await tImg.decode(); } catch (e) { }
    } else {
        await new Promise((r, j) => { tImg.onload = r; tImg.onerror = j; setTimeout(j, 3000); });
    }
    if (!tImg.naturalWidth || !tImg.naturalHeight) throw new Error("Image failed to decode");

    sharedCtx.drawImage(tImg, 0, 0, 224, 224);
    let rgbaData;
    try {
        rgbaData = sharedCtx.getImageData(0, 0, 224, 224).data;
    } catch (e) {
        // Tainted canvas (no CORS headers) — fall through to SW fetch.
        const resp = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: src }, (r) => {
                if (chrome.runtime.lastError || !r || !r.ok) reject(new Error("SW fetch failed"));
                else resolve(r);
            });
        });
        rgbaData = await drawBytesToCanvas(resp.bytes, resp.mime);
    }

    const skinResult = createSkinOverlay(rgbaData);

    const rgbData = new Uint8Array(224 * 224 * 3);
    for (let i = 0, j = 0; i < 224 * 224; i++) {
        rgbData[j++] = rgbaData[i * 4];
        rgbData[j++] = rgbaData[i * 4 + 1];
        rgbData[j++] = rgbaData[i * 4 + 2];
    }
    return { rgbData, skinCanvas: skinResult.canvas };
}

function drawBytesToCanvas(bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'image/png' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
        const tImg = new Image();
        tImg.onload = () => {
            sharedCtx.drawImage(tImg, 0, 0, 224, 224);
            URL.revokeObjectURL(url);
            resolve(sharedCtx.getImageData(0, 0, 224, 224).data);
        };
        tImg.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SW-fetched image failed to decode")); };
        tImg.src = url;
    });
}

function getSource(img) {
    let src = img.src || img.getAttribute('data-src');
    if (!src && img.style.backgroundImage) {
        src = img.style.backgroundImage.slice(4, -1).replace(/"/g, "");
    }
    if (!src && img.style.background) {
        const match = img.style.background.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (match) src = match[1];
    }
    return src || null;
}

function drawBadge(img, score) {
    const color = score >= 7 ? "#ff4444" : (score >= 4 ? "#ffbb33" : "#00C851");
    const container = (img.tagName === 'IMG') ? img.parentElement : img;
    if (!container) return;

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    const identifier = (img.src || img.getAttribute('data-src') || img.style.backgroundImage || "").slice(-15);
    let badge = null;
    try {
        badge = container.querySelector(`.ai-badge[data-id="${CSS.escape(identifier)}"]`);
    } catch (e) {
        badge = container.querySelector('.ai-badge');
    }
    if (!badge) {
        badge = document.createElement("div");
        badge.className = "ai-badge";
        badge.dataset.id = identifier;
        container.appendChild(badge);
    }
    badge.innerText = score;
    badge.style.cssText = `position:absolute; top:2px; right:2px; background:${color}; color:white; padding:2px 5px; border-radius:3px; font:bold 11px sans-serif; z-index:2147483647; pointer-events:none;`;
}

// 5. VERDICT CACHE
// url -> { score } so SPA re-renders re-apply the old verdict instead of
// accidentally un-blurring a previously flagged image.
const verdictCache = new Map();
const VERDICT_CACHE_LIMIT = 3000;

function cacheVerdict(src, score) {
    if (!src) return;
    if (verdictCache.size >= VERDICT_CACHE_LIMIT) {
        // Simple bound: drop the oldest entries.
        const drop = verdictCache.keys().next().value;
        verdictCache.delete(drop);
    }
    verdictCache.set(src, score);
}

// 6. PIPELINE
const scanQueue = [];
let activeProcesses = 0;
const MAX_CONCURRENT = 6;

function releasePendingSrc(img) {
    const src = img.__aiSrc;
    if (!src) return;
    const waiting = pendingBySrc.get(src);
    if (waiting) {
        waiting.delete(img);
        if (waiting.size === 0) pendingBySrc.delete(src);
    }
    img.__aiSrc = null;
}
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
    if (!img || !siteFilteringEnabled) return;

    const src = getSource(img);
    // Only elements with an extractable URL are scannable. Never blur things
    // we cannot analyze (canvases, CSS-class backgrounds, UI icons) — that
    // is what caused random UI elements to stay blurred.
    if (!src) return;
    if (config.blurAll) return;

    // Re-apply a cached verdict instead of trusting "safe".
    if (verdictCache.has(src)) {
        applyVerdict(img, verdictCache.get(src));
        return;
    }
    // Tiny data URIs (icons/spacers) are not worth scanning.
    if (src.startsWith('data:') && src.length < 500) {
        return;
    }

    // Mark for blur only NOW that we know we can actually scan it.
    img.classList.add('ai-filter-target');
    // Force blur immediately via CSS (by ensuring .ai-safe is NOT present)
    img.classList.remove('ai-safe');
    img.dataset.aiWaiting = "true";
    // The reveal deadline starts when the blur starts — NOT when analysis
    // starts — so a scan-queue backlog can never hold images blurred.
    if (img.__aiTimer) clearTimeout(img.__aiTimer);
    img.__aiTimer = setTimeout(() => {
        delete img.dataset.aiWaiting;
        img.__aiTimer = null;
        releasePendingSrc(img);
        // A real verdict may have landed in the meantime — never downgrade it.
        if (img.dataset.aiChecked === "true") return;
        applyVerdict(img, 0);
    }, SCAN_TIMEOUT_MS);
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
        // Relative chroma avoids rejecting any skin tone because of low absolute RGB values.
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
        const src = getSource(img);
        // Dedupe: if the same URL is already being analyzed, piggyback on it
        // instead of burning a pipeline slot (feeds repeat URLs constantly).
        if (src) {
            const pending = pendingBySrc.get(src);
            if (pending) {
                pending.add(img);
                img.__aiSrc = src;
                return;
            }
            pendingBySrc.set(src, new Set([img]));
            img.__aiSrc = src;
        }

        const { rgbData, skinCanvas } = await extractPixels(img);

        const id = uniqueId++;
        requestMap.set(id, { img, skinOverlay: skinCanvas, timeoutId: img.__aiTimer || null, src });
        chrome.runtime.sendMessage({
            type: 'ANALYZE',
            id,
            // Chrome extension messaging is JSON-only: typed arrays arrive as
            // {} on the other side, so send a plain array.
            payload: { data: Array.from(rgbData) }
        });

    } catch (e) {
        // Unscannable (decode/CORS failure): reveal rather than randomly
        // blurring half the page. Only inference results can flag an image.
        // Any duplicates piggybacking on this request are revealed too.
        if (img.__aiTimer) { clearTimeout(img.__aiTimer); img.__aiTimer = null; }
        const failedSrc = img.__aiSrc;
        img.__aiSrc = null;
        if (failedSrc && pendingBySrc.has(failedSrc)) {
            const waiting = pendingBySrc.get(failedSrc);
            pendingBySrc.delete(failedSrc);
            waiting.forEach((other) => {
                if (other.__aiTimer) { clearTimeout(other.__aiTimer); other.__aiTimer = null; }
                other.__aiSrc = null;
                applyVerdict(other, 0);
            });
        }
        img.classList.add('ai-safe');
        img.classList.remove('ai-flagged');
        img.dataset.aiChecked = "true";
    } finally {
        activeProcesses--;
        if (scanQueue.length > 0) runAnalysis(scanQueue.shift());
    }
}

function start() {
    document.querySelectorAll('img, [style*="background-image"], [style*="url("]').forEach(processImage);
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
                    if (tag === 'IMG' || tag === 'PICTURE' || node.style?.background) processImage(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img, [style*="background-image"], [style*="url("]').forEach(processImage);
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
