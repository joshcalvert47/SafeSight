// chrome-shim.js — Android WebView stand-in for the extension APIs content.js
// uses. Injected before content.js; results flow back through window.__safesight
// delivery functions that ChromeBridge calls from Kotlin.
(function () {
    'use strict';
    if (window.__safesight) return;

    var pending = new Map(); // 's3'/'m7' -> callback
    var runtimeListeners = [];
    var storageListeners = [];
    var seq = 0;
    var config = window.__SS_CONFIG || {};

    function post(msg) {
        try { window.SafeSight.postMessage(JSON.stringify(msg)); }
        catch (e) { /* bridge absent — fail open like the extension */ }
    }

    function b64FromIntArray(arr) {
        var CHUNK = 0x8000; // apply() argument-limit safe
        var parts = [];
        for (var i = 0; i < arr.length; i += CHUNK) {
            parts.push(String.fromCharCode.apply(null, arr.slice(i, i + CHUNK)));
        }
        return btoa(parts.join(''));
    }

    function uint8FromB64(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    window.__safesight = {
        // One callback channel for storage reads and sendMessage responses.
        deliver: function (key, json) {
            var cb = pending.get(key);
            if (!cb) return;
            pending.delete(key);
            try {
                var obj = JSON.parse(json);
                if (obj && typeof obj.b64 === 'string') {
                    // FETCH_IMAGE contract: content.js passes r.bytes to Blob.
                    try { obj.bytes = uint8FromB64(obj.b64); }
                    catch (e) { obj.ok = false; }
                    delete obj.b64;
                }
                cb(obj);
            } catch (e) { /* malformed response — caller fails open */ }
        },
        // chrome.runtime.onMessage pushes (AI_RESULT, SITE_TOGGLE, ...).
        emit: function (json) {
            var msg;
            try { msg = JSON.parse(json); } catch (e) { return; }
            runtimeListeners.forEach(function (fn) {
                try { fn(msg, {}, function () { }); } catch (e) { }
            });
        },
        // chrome.storage.onChanged pushes from the settings screen.
        emitStorage: function (json) {
            var changes;
            try { changes = JSON.parse(json); } catch (e) { return; }
            storageListeners.forEach(function (fn) {
                try { fn(changes); } catch (e) { }
            });
        }
    };

    // content.js only needs drawImage/getImageData, so a plain canvas is a
    // faithful fallback for WebViews without OffscreenCanvas.
    if (typeof window.OffscreenCanvas === 'undefined') {
        window.OffscreenCanvas = function (w, h) {
            var c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        };
    }

    // Additive: never clobber the page's own window.chrome.
    var chromeObj = window.chrome || {};

    chromeObj.runtime = chromeObj.runtime || {};
    chromeObj.runtime.lastError = null;
    chromeObj.runtime.getURL = function (path) {
        if (path === 'blocklist.json' && config.blocklistDataUrl) {
            return config.blocklistDataUrl;
        }
        return 'file:///android_asset/' + path;
    };
    chromeObj.runtime.sendMessage = function (message, callback) {
        var key = 'm' + (++seq);
        if (typeof callback === 'function') pending.set(key, callback);
        var out = { __ss: key };
        if (message) {
            Object.keys(message).forEach(function (k) { out[k] = message[k]; });
        }
        if (out.type === 'ANALYZE' && out.payload && out.payload.data) {
            // 150528-number JSON arrays are slow across the bridge; base64 them.
            out.b64 = b64FromIntArray(out.payload.data);
            delete out.payload;
        }
        post(out);
        return true;
    };
    chromeObj.runtime.onMessage = {
        addListener: function (fn) { runtimeListeners.push(fn); }
    };

    chromeObj.storage = chromeObj.storage || {};
    chromeObj.storage.local = {
        get: function (keys, callback) {
            var key = 's' + (++seq);
            if (typeof callback === 'function') pending.set(key, callback);
            post({ __ssGet: key, keys: Array.isArray(keys) ? keys : [keys] });
            return true;
        }
        // content.js never writes storage; the native settings UI owns writes.
    };
    chromeObj.storage.onChanged = {
        addListener: function (fn) { storageListeners.push(fn); }
    };

    window.chrome = chromeObj;
})();
