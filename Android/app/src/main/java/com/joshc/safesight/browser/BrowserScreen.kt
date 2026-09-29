package com.joshc.safesight.browser

import android.graphics.Bitmap
import android.util.Base64
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.viewModelScope
import com.joshc.safesight.block.BlocklistRepository
import com.joshc.safesight.ui.SafeSightViewModel
import android.webkit.WebResourceRequest

private const val DEFAULT_URL = "https://www.google.com"

private class BrowserHolder(val webView: WebView, val bridge: ChromeBridge)

/**
 * The extension's content-script pipeline, hosted in a WebView: chrome-shim.js
 * + content.js are injected at every document start, analysis runs through
 * ChromeBridge -> NsfwClassifier.
 */
@Composable
fun BrowserScreen(viewModel: SafeSightViewModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var address by rememberSaveable { mutableStateOf(DEFAULT_URL) }
    var pendingLoad by remember { mutableStateOf<String?>(DEFAULT_URL) }
    var holder by remember { mutableStateOf<BrowserHolder?>(null) }
    var canGoBack by remember { mutableStateOf(false) }

    val skinFilter by viewModel.skinFilter.collectAsState(initial = false)
    val blurAll by viewModel.blurAll.collectAsState(initial = false)
    val sensitivity by viewModel.sensitivity.collectAsState(initial = 4)
    val accountReady by viewModel.accountReady.collectAsState(initial = false)
    val blockedSites by viewModel.store.blockedSites.collectAsState(initial = emptyList())
    val allowedSites by viewModel.store.allowedSites.collectAsState(initial = emptyList())
    val effectiveBlocklist by viewModel.blocklist.effective.collectAsState(initial = emptyList())
    val blocklistUser by viewModel.store.blocklistUser.collectAsState(initial = emptyList())
    val blocklistRemoved by viewModel.store.blocklistRemoved.collectAsState(initial = emptyList())

    val injectionSource = remember(context) {
        val assets = context.assets
        val blocklistB64 = assets.open("blocklist.json").use {
            Base64.encodeToString(it.readBytes(), Base64.NO_WRAP)
        }
        val shim = assets.open("chrome-shim.js").bufferedReader().readText()
        val content = assets.open("content.js").bufferedReader().readText()
        "if(!window.__SS_INJECTED){window.__SS_INJECTED=1;\n" +
            "window.__SS_CONFIG={blocklistDataUrl:'data:application/json;base64,$blocklistB64'};\n" +
            shim + "\n" + content + "\n}"
    }

    // Live settings push — the same event chrome.storage.onChanged delivers
    // to the extension's content script.
    LaunchedEffect(
        holder,
        skinFilter, blurAll, sensitivity, accountReady,
        blockedSites, allowedSites, blocklistUser, blocklistRemoved,
    ) {
        holder?.bridge?.pushConfig(
            mapOf(
                "skinFilter" to skinFilter,
                "blurAll" to blurAll,
                "sensitivity" to sensitivity,
                "accountReady" to accountReady,
                "blockedSites" to blockedSites,
                "allowedSites" to allowedSites,
                "blocklistUser" to blocklistUser,
                "blocklistRemoved" to blocklistRemoved,
            ),
        )
    }

    fun submit() {
        val target = normalizeInput(address) ?: return
        pendingLoad = target
        address = target
    }

    BackHandler(enabled = canGoBack) { holder?.webView?.goBack() }

    Column(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                placeholder = { Text("Search or address") },
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { submit() }),
            )
            IconButton(onClick = { submit() }) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = "Go",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }

        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    // blocked.html lives in assets and loads blocked.js/icon.png
                    // as file:// subresources — required with targetSdk >= 30.
                    settings.allowFileAccess = true
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    settings.setSupportZoom(true)

                    val bridge = ChromeBridge(
                        webView = this,
                        classifier = viewModel.classifier,
                        store = viewModel.store,
                        scope = viewModel.viewModelScope,
                    )
                    addJavascriptInterface(bridge, "SafeSight")

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean {
                            val url = request.url
                            val scheme = url.scheme?.lowercase()
                            if (scheme != "http" && scheme != "https") return false
                            val host = url.host ?: return false
                            if (!BlocklistRepository.matches(host, effectiveBlocklist)) return false
                            if (request.isForMainFrame) {
                                view.loadUrl(
                                    BlocklistRepository.blockedPageUrl(
                                        url.toString(),
                                        host.removePrefix("www."),
                                    ),
                                )
                            }
                            return true
                        }

                        override fun onPageStarted(
                            view: WebView?,
                            url: String?,
                            favicon: Bitmap?,
                        ) {
                            super.onPageStarted(view, url, favicon)
                            view?.evaluateJavascript(injectionSource, null)
                            if (url != null && url.startsWith("http")) address = url
                            canGoBack = view?.canGoBack() == true
                        }

                        override fun doUpdateVisitedHistory(
                            view: WebView?,
                            url: String?,
                            isReload: Boolean,
                        ) {
                            super.doUpdateVisitedHistory(view, url, isReload)
                            if (url != null && url.startsWith("http")) address = url
                            canGoBack = view?.canGoBack() == true
                        }
                    }
                    holder = BrowserHolder(this, bridge)
                }
            },
            update = { wv ->
                pendingLoad?.let { wv.loadUrl(it) }
                pendingLoad = null
            },
            onRelease = { wv ->
                holder?.bridge?.close()
                wv.destroy()
                holder = null
            },
        )
    }
}

/** Address-bar input: URLs keep their scheme, anything else becomes a search. */
internal fun normalizeInput(raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty()) return null
    if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) return t
    if (t.startsWith("//")) return "https:$t"
    return if (t.contains('.') && !t.contains(' ')) {
        "https://$t"
    } else {
        "https://duckduckgo.com/?q=" + java.net.URLEncoder.encode(t, "UTF-8")
    }
}
