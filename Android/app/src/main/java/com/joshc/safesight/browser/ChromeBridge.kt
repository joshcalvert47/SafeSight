package com.joshc.safesight.browser

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.joshc.safesight.data.SettingsStore
import com.joshc.safesight.ml.NsfwClassifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The native half of the chrome.* bridge. content.js talks to this through
 * window.SafeSight.postMessage (see assets/chrome-shim.js); responses and
 * AI_RESULT pushes go back via window.__safesight delivery functions.
 *
 * Contract with the extensions:
 *  - ANALYZE  -> score from NsfwClassifier -> {type:'AI_RESULT', id, score}
 *  - FETCH_IMAGE -> {ok, bytes(Uint8), mime} (host-permission style CORS bypass)
 *  - BUMP_STATS -> counters coalesced every 3s like service-worker bumpStats()
 *  - BLOCK_SITE_NAV -> {ok:true} then navigate to the local blocked page
 */
class ChromeBridge(
    private val webView: WebView,
    private val classifier: NsfwClassifier,
    private val store: SettingsStore,
    private val scope: CoroutineScope,
) {
    private val http = OkHttpClient()
    private val inference = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lock = Any()
    private var scanned = 0
    private var blocked = 0
    private val flushScheduled = AtomicBoolean(false)

    @JavascriptInterface
    fun postMessage(json: String) {
        try {
            handle(JSONObject(json))
        } catch (e: Throwable) {
            // Malformed or failing messages must never take the page down.
        }
    }

    private fun handle(msg: JSONObject) {
        when {
            msg.has("__ssGet") -> storageGet(msg.getString("__ssGet"), msg.optJSONArray("keys"))

            msg.optString("type") == "ANALYZE" -> analyze(
                key = msg.optString("__ss"),
                id = msg.opt("id"),
                b64 = msg.optString("b64"),
            )

            msg.optString("type") == "FETCH_IMAGE" -> fetchImage(
                key = msg.getString("__ss"),
                url = msg.optString("url"),
            )

            msg.optString("type") == "BUMP_STATS" ->
                bumpStats(msg.optBoolean("blocked"))

            msg.optString("type") == "BLOCK_SITE_NAV" -> {
                deliver(msg.optString("__ss"), JSONObject().put("ok", true).toString())
                val url = msg.optString("url")
                val site = msg.optString("site")
                mainHandler.post { loadBlockedPage(url, site) }
            }
        }
    }

    private fun storageGet(key: String, keys: JSONArray?) {
        val requested = buildList {
            if (keys != null) for (i in 0 until keys.length()) add(keys.optString(i))
        }
        scope.launch(Dispatchers.IO) {
            val snapshot = store.getFor(requested)
            val json = JSONObject()
            snapshot.forEach { (k, v) ->
                json.put(
                    k,
                    when (v) {
                        null -> JSONObject.NULL
                        is Boolean -> v
                        is Int -> v
                        is Long -> v
                        is String -> v
                        is List<*> -> JSONArray(v)
                        else -> JSONObject.NULL
                    },
                )
            }
            deliver(key, json.toString())
        }
    }

    private fun analyze(key: String, id: Any?, b64: String) {
        inference.execute {
            val score = try {
                val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                classifier.analyzeRgb(bytes)
            } catch (t: Throwable) {
                0 // fail open, same as offscreen.js
            }
            // id is content.js's own request id (number or string) — echo as-is.
            val payload = JSONObject()
                .put("type", "AI_RESULT")
                .put("id", id ?: JSONObject.NULL)
                .put("score", score)
            emit(payload.toString())
        }
    }

    private fun fetchImage(key: String, url: String) {
        inference.execute {
            val resp = JSONObject()
            try {
                val request = Request.Builder().url(url).build()
                http.newCall(request).execute().use { r ->
                    if (!r.isSuccessful) throw IllegalStateException("HTTP ${r.code}")
                    val mime = r.header("Content-Type") ?: "image/png"
                    val body = r.body?.bytes() ?: ByteArray(0)
                    resp.put("ok", true)
                    resp.put("mime", mime)
                    resp.put(
                        "b64",
                        android.util.Base64.encodeToString(body, android.util.Base64.NO_WRAP),
                    )
                }
            } catch (e: Throwable) {
                resp.put("ok", false).put("error", e.message ?: "fetch failed")
            }
            deliver(key, resp.toString())
        }
    }

    private fun bumpStats(wasBlocked: Boolean) {
        synchronized(lock) {
            scanned++
            if (wasBlocked) blocked++
            if (flushScheduled.compareAndSet(false, true)) {
                mainHandler.postDelayed(::flushStats, 3000)
            }
        }
    }

    private fun flushStats() {
        flushScheduled.set(false)
        val s: Int
        val b: Int
        synchronized(lock) {
            s = scanned
            b = blocked
            scanned = 0
            blocked = 0
        }
        if (s > 0 || b > 0) scope.launch(Dispatchers.IO) { store.incrementStats(s, b) }
    }

    private fun loadBlockedPage(url: String, site: String) {
        val target = "file:///android_asset/blocked.html" +
            "?url=" + java.net.URLEncoder.encode(url, "UTF-8") +
            "&site=" + java.net.URLEncoder.encode(site, "UTF-8")
        webView.loadUrl(target)
    }

    private fun emit(json: String) = runJs("window.__safesight && window.__safesight.emit(" + q(json) + ")")

    /**
     * Push settings as a chrome.storage.onChanged event so an open page
     * re-evaluates blur-all / sensitivity / site lists live.
     */
    fun pushConfig(values: Map<String, Any?>) {
        val changes = JSONObject()
        values.forEach { (k, v) ->
            val nv = when (v) {
                null -> JSONObject.NULL
                is List<*> -> JSONArray(v)
                else -> v
            }
            changes.put(k, JSONObject().put("newValue", nv))
        }
        runJs("window.__safesight && window.__safesight.emitStorage(" + q(changes.toString()) + ")")
    }

    private fun deliver(key: String, json: String) =
        runJs("window.__safesight && window.__safesight.deliver(" + q(key) + "," + q(json) + ")")

    private fun runJs(js: String) {
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    private fun q(s: String): String = JSONObject.quote(s)

    fun close() {
        inference.shutdownNow()
        mainHandler.removeCallbacksAndMessages(null)
    }
}
