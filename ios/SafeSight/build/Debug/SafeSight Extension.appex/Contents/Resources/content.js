// content.js (iOS / Safari)
// Same pipeline as the Chrome build. iOS-specific adaptations:
//   - Safari MV3 does not support "exclude_matches" in content_scripts, so the
//     mail.google.com / discord.com exclusions are applied here in JS.
//   - OffscreenCanvas is not exposed to content scripts on iOS Safari, so the
//     shared 224x224 draw target is a detached DOM canvas.
let config = { skinFilter: false, blurAll: false, sensitivity: 4, blockedSites: [], allowedSites: [], accountReady: false };
const SKIN_COVERAGE_THRESHOLD = 0.12;
const SCAN_TIMEOUT_MS = 5000; // Reveal if no verdict within 5s of the blur starting.
const ENGINE_WARM_MAX_WAIT_MS = 60000;
let engineWarm = false;
let engineColdSinceMs = null;
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

// 0. SITE BLOCKLIST
const BLOCKLIST_KEYS = ['blocklistDefaults', 'blocklistUser', 'blocklistRemoved'];
let blocklistDefaultsPromise = null;

function normalizeSite(entry) {
    if (typeof entry !== 'string') return null;
    let s = entry.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[\/?#]/)[0];
    s = s.split('@').pop().split(':')[0];
    s = s.replace(/^\*\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return s.includes('.') ? s : null;
}

function loadDefaultBlocklist() {
    if (!blocklistDefaultsPromise) {
        blocklistDefaultsPromise = fetch(chrome.runtime.getURL('blocklist.json'))
            .then((r) => r.json())
            .then((data) => {
                const list = Array.isArray(data) ? data : ((data && data.sites) || []);
                return list.map(normalizeSite).filter(Boolean);
            })
            .catch(() => {
                blocklistDefaultsPromise = null;
                return [];
            });
    }
    return blocklistDefaultsPromise;
}

async function getEffectiveBlocklist() {
    const stored = await new Promise((resolve) => chrome.storage.local.get(BLOCKLIST_KEYS, resolve));
    const defaults = Array.isArray(stored.blocklistDefaults)
        ? stored.blocklistDefaults
        : await loadDefaultBlocklist();
    const removed = new Set(Array.isArray(stored.blocklistRemoved) ? stored.blocklistRemoved : []);
    const user = Array.isArray(stored.blocklistUser) ? stored.blocklistUser : [];
    return [...new Set([...defaults.filter((s) => !removed.has(s)), ...user])];
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

function isQuietNow(res) {
    if (!res || !res.quietEnabled) return false;
    const s = parseHM(res.quietStart);
    const e = parseHM(res.quietEnd);
    if (s === null || e === null || s === e) return false;
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    return s < e ? (current >= s && current < e) : (current >= s || current < e);
}

async function enforceSiteBlock() {
    try {
        const state = await new Promise((resolve) => chrome.storage.local.get(
            ['accountReady', 'filtersEnabled', 'quietEnabled', 'quietStart', 'quietEnd'], resolve));
        if (!state || !state.accountReady) return;
        if (!/^https?:$/.test(location.protocol)) return;
        const host = location.hostname.replace(/^www\./, '');
        if (!host) return;
        if (state.filtersEnabled === false) return;
        const quiet = isQuietNow(state);
        if (!quiet) {
            const list = await getEffectiveBlocklist();
            const isBlocked = list.some((site) => host === site || host.endsWith('.' + site));
            if (!isBlocked) return;
        }
        if (window.top !== window) {
            location.replace('about:blank');
            return;
        }
        const reason = quiet ? 'quiet' : '';
        chrome.runtime.sendMessage({ type: 'BLOCK_SITE_NAV', url: location.href, site: host, reason }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
                try { location.replace(blockedPageUrl(location.href, host, reason)); } catch (e) { }
            }
        });
    } catch (e) { }
}
enforceSiteBlock();

const EXCLUDED_HOSTS = ['mail.google.com', 'discord.com'];
function isExcludedPage() {
    try {
        return EXCLUDED_HOSTS.some((h) => location.hostname === h || location.hostname.endsWith('.' + h));
    } catch (e) { return false; }
}

if (!isExcludedPage()) {

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
    chrome.storage.local.get(['skinFilter', 'blurAll', 'sensitivity', 'blockedSites', 'allowedSites', 'accountReady'], (res) => {
        config.accountReady = !!res.accountReady;
        config.skinFilter = !!res.skinFilter;
        config.blurAll = !!res.blurAll;
        config.sensitivity = res.sensitivity ?? 4;
        config.blockedSites = Array.isArray(res.blockedSites) ? res.blockedSites : [];
        config.allowedSites = Array.isArray(res.allowedSites) ? res.allowedSites : [];
        siteFilteringEnabled = !isSiteBlocked() || isSiteAllowed();
        updateGlobalBlur();
        // The account flag can already be true here (returning visit, login
        // completed earlier). The DOMContentLoaded start() below races this
        // callback at document_start, so scan what is on the page as soon as
        // storage answers instead of trusting the race.
        if (config.accountReady) start();
    });
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes.blurAll) config.blurAll = changes.blurAll.newValue;
    if (changes.skinFilter) config.skinFilter = changes.skinFilter.newValue;
    if (changes.sensitivity) config.sensitivity = changes.sensitivity.newValue;
    if (changes.accountReady) config.accountReady = !!changes.accountReady.newValue;
    if (changes.blockedSites) config.blockedSites = Array.isArray(changes.blockedSites.newValue) ? changes.blockedSites.newValue : [];
    if (changes.allowedSites) config.allowedSites = Array.isArray(changes.allowedSites.newValue) ? changes.allowedSites.newValue : [];
    if (changes.blocklistUser || changes.blocklistRemoved || changes.blocklistDefaults) enforceSiteBlock();
    if (changes.filtersEnabled || changes.quietEnabled || changes.quietStart || changes.quietEnd) enforceSiteBlock();
    siteFilteringEnabled = config.accountReady && (!isSiteBlocked() || isSiteAllowed());
    updateGlobalBlur();
    if (config.accountReady) start();
});

// 3. RESULT HANDLING
function finishRequest(request, finalScore) {
    const img = request.img;
    if (img && img.__aiTimer) { clearTimeout(img.__aiTimer); img.__aiTimer = null; }
    else if (request.timeoutId) clearTimeout(request.timeoutId);

    chrome.runtime.sendMessage({
        type: 'BUMP_STATS',
        blocked: Number(finalScore) >= config.sensitivity
    });

    if (img) {
        if (request.src) {
            cacheVerdict(request.src, Number(finalScore));
            const waiting = pendingBySrc.get(request.src);
            if (waiting) {
                pendingBySrc.delete(request.src);
                waiting.forEach((other) => {
                    if (other !== img && other.isConnected) applyVerdict(other, finalScore);
                });
            }
        }
        applyVerdict(img, finalScore, request.skinOverlay);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AI_RESULT') {
        if (!engineWarm) {
            engineWarm = true;
            engineColdSinceMs = null;
        }
        const { id, score } = message;
        const request = requestMap.get(id);
        if (!request) return;
        requestMap.delete(id);

        const firstScore = Number(score);
        const sensitivity = config.sensitivity ?? 4;

        if (request.secondPass) {
            finishRequest(request, (request.firstScore + firstScore) / 2);
            return;
        }

        if (request.cropRgbData && Math.abs(firstScore - sensitivity) <= 2) {
            const retryId = uniqueId++;
            requestMap.set(retryId, {
                ...request,
                cropRgbData: null,
                secondPass: true,
                firstScore,
                timeoutId: null
            });
            chrome.runtime.sendMessage({
                type: 'ANALYZE',
                id: retryId,
                payload: { data: Array.from(request.cropRgbData) }
            });
            return;
        }

        finishRequest(request, firstScore);
        return;
    }

    if (message.type === 'SITE_TOGGLE') {
        siteFilteringEnabled = message.enabled;
        if (siteFilteringEnabled) {
            start();
        } else {
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
    img.classList.add('ai-filter-target');
    img.dataset.aiChecked = "true";
    if (config.skinFilter) showSkinOverlay(img, skinOverlay);

    if (Number(score) >= config.sensitivity) {
        img.classList.add('ai-flagged');
        img.classList.remove('ai-safe');
    } else {
        img.classList.add('ai-safe');
        img.classList.remove('ai-flagged');
    }
}


// 4. IMAGE ACQUISITION
function rgbaToRgb(rgbaData) {
    const rgbData = new Uint8Array(224 * 224 * 3);
    for (let i = 0, j = 0; i < 224 * 224; i++) {
        rgbData[j++] = rgbaData[i * 4];
        rgbData[j++] = rgbaData[i * 4 + 1];
        rgbData[j++] = rgbaData[i * 4 + 2];
    }
    return rgbData;
}

const cropCanvas = document.createElement('canvas');
cropCanvas.width = 224;
cropCanvas.height = 224;
const cropCtx = cropCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

function centerCropRgb(sourceImg) {
    try {
        if (!sourceImg || !sourceImg.naturalWidth || !sourceImg.naturalHeight) return null;
        const w = sourceImg.naturalWidth;
        const h = sourceImg.naturalHeight;
        const side = Math.min(w, h);
        cropCtx.drawImage(sourceImg, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 224, 224);
        return rgbaToRgb(cropCtx.getImageData(0, 0, 224, 224).data);
    } catch (e) {
        return null;
    }
}

function decodeBytesToImage(bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'image/png' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Background-fetched image failed to decode")); };
        img.src = url;
    });
}

function fetchImageBytes(src) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: src }, (r) => {
            if (chrome.runtime.lastError || !r || !r.ok) reject(new Error("Background fetch failed"));
            else resolve(r);
        });
    });
}

async function extractPixels(img) {
    const src = getSource(img);
    if (!src) throw new Error("No source");

    let sourceImg = null;
    let rgbaData = null;

    const tImg = new Image();
    tImg.crossOrigin = "Anonymous";
    tImg.src = src;
    if (tImg.decode) {
        try { await tImg.decode(); } catch (e) { }
    } else {
        await new Promise((r, j) => { tImg.onload = r; tImg.onerror = j; setTimeout(j, 3000); });
    }

    if (tImg.naturalWidth && tImg.naturalHeight) {
        sourceImg = tImg;
        sharedCtx.drawImage(tImg, 0, 0, 224, 224);
        try {
            rgbaData = sharedCtx.getImageData(0, 0, 224, 224).data;
        } catch (e) { }
    }

    if (!rgbaData) {
        const resp = await fetchImageBytes(src);
        sourceImg = await decodeBytesToImage(resp.bytes, resp.mime);
        sharedCtx.drawImage(sourceImg, 0, 0, 224, 224);
        rgbaData = sharedCtx.getImageData(0, 0, 224, 224).data;
    }

    const skinResult = createSkinOverlay(rgbaData);

    return {
        rgbData: rgbaToRgb(rgbaData),
        skinCanvas: skinResult.canvas,
        cropRgbData: centerCropRgb(sourceImg)
    };
}

function getSource(img) {
    const lazyAttrs = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-src-original'];
    for (const attr of lazyAttrs) {
        const val = img.getAttribute(attr);
        if (val && val.length > 10) return val;
    }

    if (img.srcset) {
        const parts = img.srcset.split(',');
        if (parts.length > 0) {
            const best = parts[parts.length - 1].trim().split(' ')[0];
            if (best && best.length > 10) return best;
        }
    }

    if (img.style.backgroundImage) {
        return img.style.backgroundImage.slice(4, -1).replace(/"/g, "");
    }
    if (img.style.background) {
        const match = img.style.background.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (match) return match[1];
    }
    return null;
}


// 5. VERDICT CACHE
const verdictCache = new Map();
const VERDICT_CACHE_LIMIT = 3000;

function cacheVerdict(src, score) {
    if (!src) return;
    if (verdictCache.size >= VERDICT_CACHE_LIMIT) {
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
const sharedCanvas = document.createElement('canvas');
sharedCanvas.width = 224;
sharedCanvas.height = 224;
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
    if (!img || !config.accountReady || !siteFilteringEnabled) return;

    const src = getSource(img);
    if (!src) return;
    if (config.blurAll) return;

    if (verdictCache.has(src)) {
        applyVerdict(img, verdictCache.get(src));
        return;
    }
    if (src.startsWith('data:') && src.length < 500) {
        return;
    }

    img.classList.add('ai-filter-target');
    img.classList.remove('ai-safe');
    img.dataset.aiWaiting = "true";
    if (img.__aiTimer) clearTimeout(img.__aiTimer);
    // iOS cold-start: the model can legitimately take longer than
    // SCAN_TIMEOUT_MS to deliver its FIRST verdict (engine load + warm-up +
    // first inference). Revealing at 5s would un-blur every flagged image
    // before any verdict ever lands — the "images blur then unblur" bug. The
    // deadline therefore only runs once the engine has proven warm (first
    // AI_RESULT); while cold it re-arms, bounded by ENGINE_WARM_MAX_WAIT_MS so
    // nothing is ever stuck blurred forever.
    if (!engineWarm && engineColdSinceMs === null) engineColdSinceMs = Date.now();
    img.__aiTimer = setTimeout(function revealDeadline() {
        if (!engineWarm && engineColdSinceMs !== null &&
            Date.now() - engineColdSinceMs < ENGINE_WARM_MAX_WAIT_MS) {
            img.__aiTimer = setTimeout(revealDeadline, SCAN_TIMEOUT_MS);
            return;
        }
        delete img.dataset.aiWaiting;
        img.__aiTimer = null;
        releasePendingSrc(img);
        if (img.dataset.aiChecked === "true") return;
        applyVerdict(img, 0);
    }, SCAN_TIMEOUT_MS);
    intersectionObserver.observe(img);
}

function createSkinOverlay(rgbaData) {
    let skinPixels = 0;
    let red = 0, green = 0, blue = 0;
    let minX = 224, minY = 224, maxX = -1, maxY = -1;
    const pixelCount = rgbaData.length / 4;
    const skinMask = new Uint8Array(pixelCount);

    for (let i = 0, pixel = 0; i < rgbaData.length; i += 4, pixel++) {
        const r = rgbaData[i], g = rgbaData[i + 1], b = rgbaData[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const brightness = (r + g + b) / 3;
        const total = r + g + b || 1;
        const redShare = r / total, greenShare = g / total, blueShare = b / total;
        const isSkin = brightness > 8 && max - min > 4 &&
            redShare >= greenShare * 0.96 && greenShare >= blueShare * 0.96 &&
            redShare > blueShare * 1.04;

        if (isSkin) {
            const x = pixel % 224, y = Math.floor(pixel / 224);
            skinMask[pixel] = 1;
            skinPixels++;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            red += r; green += g; blue += b;
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
        const x = pixel % 224, y = Math.floor(pixel / 224);
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

        const { rgbData, skinCanvas, cropRgbData } = await extractPixels(img);
        const id = uniqueId++;
        requestMap.set(id, { img, skinOverlay: skinCanvas, timeoutId: img.__aiTimer || null, src, cropRgbData });
        chrome.runtime.sendMessage({
            type: 'ANALYZE',
            id,
            payload: { data: Array.from(rgbData) }
        });

    } catch (e) {
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
    if (!config.accountReady) return;
    document.querySelectorAll('img, [style*="background-image"], [style*="url("]').forEach(processImage);
}

loadConfig();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

const observer = new MutationObserver(m => {
    if (!config.accountReady || config.blurAll) return;
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
                if (attr === 'style' || attr === 'src' || attr === 'data-src' || attr === 'srcset' || attr === 'data-original') {
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
    attributeFilter: ['src', 'style', 'data-src', 'srcset', 'data-original']
});

}
