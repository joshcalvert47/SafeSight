// element-tools.js — the zapper and the picker.
//
// Injected on demand by the popup button or the keyboard command via
// chrome.scripting.executeScript. Not a declared content script: it has no
// business running on every page load.
//
// Both tools share one overlay. The zapper hides what you click and remembers
// it for that host; the picker only reports the selector it would use, so you
// can hand it on.
//
// Selector generation is the part that is easy to get wrong: it must produce
// something that (a) matches the element it came from, and (b) still matches
// after a reload with duplicate classes around it. So it prefers an id, then a
// unique attribute, and only then a structural path — and every candidate is
// verified against document.querySelectorAll before it is used.
// Injecting this file defines a factory on the isolated-world window; the
// service worker then calls it with a mode, because executeScript({files})
// cannot pass arguments.
window.__safesightElementToolsFactory = function (mode) {
    if (window.__safesightElementTools) {
        window.__safesightElementTools.stop();
    }

    const OVERLAY_ID = 'safesight-picker-overlay';
    const LABEL_ID = 'safesight-picker-label';
    const HOST = location.hostname.replace(/^www\./, '');

    let current = null;
    let stopped = false;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = 'position:fixed; z-index:2147483647; pointer-events:none;' +
        'border:2px solid #6366f1; background:rgba(99,102,241,0.18); border-radius:3px;' +
        'transition:all 0.05s linear; box-sizing:border-box;';

    const label = document.createElement('div');
    label.id = LABEL_ID;
    label.style.cssText = 'position:fixed; z-index:2147483647; pointer-events:none;' +
        'background:#6366f1; color:#fff; font:600 11px ui-monospace,Menlo,monospace;' +
        'padding:3px 6px; border-radius:4px; max-width:70vw; overflow:hidden;' +
        'text-overflow:ellipsis; white-space:nowrap;';

    function mount() {
        (document.body || document.documentElement).appendChild(overlay);
        (document.body || document.documentElement).appendChild(label);
    }

    function selectorFor(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id && !/^\d/.test(el.id)) {
            const s = '#' + CSS.escape(el.id);
            try { if (document.querySelectorAll(s).length === 1) return s; } catch (e) { }
        }
        // A unique data attribute is far more stable than a class list.
        for (const attr of ['data-testid', 'data-test-id', 'data-ad-slot', 'data-ad-client', 'role']) {
            const v = el.getAttribute && el.getAttribute(attr);
            if (!v) continue;
            const s = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v)}"]`;
            try { if (document.querySelectorAll(s).length === 1) return s; } catch (e) { }
        }
        // Structural path, verified unique, stopping at the first uniquely
        // identifiable ancestor so the selector does not grow without bound.
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
            let part = node.tagName.toLowerCase();
            const cls = Array.from(node.classList || [])
                .filter((c) => c && !/^a[i]?-/.test(c))
                .slice(0, 2)
                .map((c) => '.' + CSS.escape(c))
                .join('');
            if (cls) part += cls;
            const parent = node.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
                if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
            }
            parts.unshift(part);
            const candidate = parts.join(' > ');
            try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) { }
            node = parent;
        }
        return parts.join(' > ') || null;
    }

    function move(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === overlay || el === label || el === current) return;
        current = el;
        const r = el.getBoundingClientRect();
        overlay.style.left = r.left + 'px';
        overlay.style.top = r.top + 'px';
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
        const sel = selectorFor(el);
        label.textContent = (mode === 'zap' ? 'Zap: ' : 'Pick: ') + (sel || '(no selector)');
        const ly = r.top > 24 ? r.top - 20 : r.bottom + 4;
        label.style.left = Math.max(4, r.left) + 'px';
        label.style.top = ly + 'px';
    }

    async function click(e) {
        e.preventDefault();
        e.stopPropagation();
        const el = current || document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        const sel = selectorFor(el);
        if (!sel) { finish({ ok: false, error: 'could not build a selector for that element' }); return; }
        if (mode === 'zap') {
            el.style.setProperty('display', 'none', 'important');
            finish({ ok: true, selector: sel, action: 'zap', host: HOST });
        } else {
            finish({ ok: true, selector: sel, action: 'pick', host: HOST });
        }
    }

    let done = false;
    function finish(result) {
        if (done) return;
        done = true;
        stop();
        try { chrome.runtime.sendMessage({ type: 'ELEMENT_TOOL_RESULT', mode, result }); } catch (err) { }
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        overlay.remove();
        label.remove();
        window.__safesightElementTools = null;
    }

    function key(e) {
        if (e.key === 'Escape') { stop(); try { chrome.runtime.sendMessage({ type: 'ELEMENT_TOOL_CANCELLED', mode }); } catch (err) { } }
    }

    mount();
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);

    window.__safesightElementTools = { stop, selectorFor };
    return { ok: true, mode, host: HOST };
};
