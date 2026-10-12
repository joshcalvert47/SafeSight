// cosmetic.js — element hiding (the cheap half of what uBlock Origin does).
//
// Runs at document_start so hidden elements never flash, and it is deliberately
// separate from content.js: content.js owns the ML image lane and does nothing
// until an account exists, whereas hiding an ad container needs no account, no
// network and no inference.
//
// Two sources of selectors:
//   1. userCSS[host]  — elements the user zapped or picked, per site, stored
//      locally. Zapping on one site never affects another.
//   2. cosmetic-filters.json — a small shipped set of generic ad-container
//      selectors. Generic hiding is the classic way to break a working site, so
//      this list is intentionally short and only contains containers that are
//      ad scaffolding (never a plain `img` or a layout wrapper).
(function () {
    if (window.__safesightCosmeticInstalled) return;
    window.__safesightCosmeticInstalled = true;

    const STYLE_ID = 'safesight-cosmetic';
    let genericSelectors = null;
    let styleEl = null;

    function host() {
        try { return location.hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    }

    function ensureStyle() {
        if (styleEl && styleEl.isConnected) return styleEl;
        styleEl = document.getElementById(STYLE_ID);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            // document_start: <head> may not exist yet, so attach to the root.
            (document.head || document.documentElement).appendChild(styleEl);
            if (!styleEl.isConnected) {
                // Truly nothing to attach to yet; retry on the first mutation.
                styleEl = null;
                document.addEventListener('readystatechange', () => apply(), { once: true });
                return null;
            }
        }
        return styleEl;
    }

    function escapeSelector(sel) {
        // A stored selector is CSS, not a value: only strip characters that would
        // let a broken entry escape its own rule block.
        return String(sel || '').replace(/[{}]/g, '');
    }

    const rule = (sel) => `${escapeSelector(sel)} { display: none !important; }`;

    async function loadGeneric() {
        if (genericSelectors) return genericSelectors;
        try {
            const resp = await fetch(chrome.runtime.getURL('cosmetic-filters.json'));
            const data = await resp.json();
            genericSelectors = Array.isArray(data) ? data : (data.selectors || []);
        } catch (e) {
            genericSelectors = [];
        }
        return genericSelectors;
    }

    let lastCss = null;

    async function apply() {
        const h = host();
        const res = await new Promise((r) => chrome.storage.local.get(['userCSS', 'filterSiteOff'], r));

        const off = Array.isArray(res.filterSiteOff) && res.filterSiteOff.some((s) => h === s || h.endsWith('.' + s));
        const userList = (res.userCSS && h && res.userCSS[h]) || [];
        const generic = off ? [] : await loadGeneric();

        const rules = [];
        for (const sel of userList) rules.push(rule(sel));
        // Site-specific user rules always win; generic ones are suppressed when
        // the user has turned filtering off for this site.
        for (const sel of generic) rules.push(rule(sel));

        const css = rules.join('\n');
        if (css === lastCss) return;
        lastCss = css;
        const el = ensureStyle();
        if (!el) return;
        el.textContent = css;
        try {
            chrome.runtime.sendMessage({ type: 'COSMETIC_APPLIED', host: h, count: rules.length });
        } catch (e) { /* worker asleep; not important */ }
    }

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.userCSS || changes.filterSiteOff) {
            lastCss = null;
            apply();
        }
    });

    apply();
})();
