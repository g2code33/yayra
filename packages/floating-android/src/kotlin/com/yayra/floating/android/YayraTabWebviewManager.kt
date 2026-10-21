package com.yayra.floating.android

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.util.Base64
import android.os.Message
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import com.getcapacitor.JSObject
import org.json.JSONObject

/**
 * IN-APP NATIVE TAB WEBVIEW ENGINE - the Android equivalent of the desktop
 * Electron WebContentsView engine (electron/webviewBridge.cjs).
 *
 * Why it exists: Yayra's app UI runs inside ONE Capacitor WebView, and
 * frame-hostile sites (Google, YouTube, X, Facebook, ... - exactly the
 * sites people use every day) send X-Frame-Options / frame-ancestors
 * headers that make them IMPOSSIBLE to render in any nested <iframe>.
 * Until now those sites were handed off to Chrome Custom Tabs, which the
 * user experiences as "Google doesn't work in Yayra / it opens in another
 * app". A real top-level WebView navigation has NO iframe restrictions,
 * so this manager layers real WebViews INSIDE Yayra's own activity window
 * and those sites genuinely render in-app.
 *
 * No SYSTEM_ALERT_WINDOW permission is needed: the views are children of
 * the app's own window (unlike the system-wide floating bubble).
 *
 * Coordinate contract with the JS side: x/y/width/height arrive in CSS
 * pixels relative to the Capacitor WebView; they are multiplied by the
 * screen density and offset by the WebView's own position inside the
 * activity content view (0/0 in the normal case).
 *
 * Events flow back to JS as "tabWebEvent" notifications:
 *   { id, type: 'loading-start' | 'loading-stop' | 'load-succeeded' |
 *               'fail-load' | 'navigated' | 'title-updated' |
 *               'google-account-auth-required' |
 *               'auth-navigation-blocked' | 'engine-error', url?, title?,
 *               canGoBack?, canGoForward?, isLoading?, error? }
 * and are normalized into the SAME shapes the desktop engine emits
 * (handleNativeWebviewEvent in BrowserShell.js handles both).
 */
class YayraTabWebviewManager(
    private val activity: Activity,
    private val anchorView: View?,
    private val emit: (JSObject) -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    private val tabs = HashMap<String, TabEntry>()
    private val density: Float get() = activity.resources.displayMetrics.density

    private companion object {
        // Keep in sync with BrowserShell.isSystemBrowserAuthHost() and
        // electron/webviewBridge.cjs. Third-party OAuth uses the OS browser;
        // first-party interactive Google Account entry is canceled here and
        // BrowserShell starts Yayra's callback-returning native OAuth bridge.
        // Ordinary Google product navigation stays in the native view.
        val SYSTEM_BROWSER_AUTH_HOSTS = setOf(
            "appleid.apple.com",
            "login.live.com",
            "login.microsoftonline.com"
        )
        val GOOGLE_OAUTH_PATH = Regex(
            "^/(?:o/oauth2(?:/|$)|oauth2(?:/|$)|signin/oauth(?:/|$)|gsi/select(?:/|$))",
            RegexOption.IGNORE_CASE
        )
        val GOOGLE_INTERACTIVE_SIGNIN_PATH = Regex(
            "^/(?:signin/(?:v2|challenge|identifier|rejected)(?:/|$)|v3/signin(?:/|$)|ServiceLogin(?:/|$)|InteractiveLogin(?:/|$)|AccountChooser(?:/|$)|AddSession(?:/|$))",
            RegexOption.IGNORE_CASE
        )
        val GOOGLE_REJECTED_SIGNIN_PATH = Regex(
            "^/(?:signin/rejected|v3/signin/rejected)(?:/|$)",
            RegexOption.IGNORE_CASE
        )
        const val MAX_AUTH_HANDOFF_URL_LENGTH = 8192
    }

    private class TabEntry(val id: String) {
        lateinit var webView: WebView
        lateinit var snapshot: ImageView
        var currentUrl: String? = null
        var lastReportedUrl: String? = null
        var mainFrameFailed: Boolean = false
        var pointerTheme: String = "system"
        var pointerSize: String = "normal"
    }

    private fun isYayraGoogleAccountConnectionUrl(uri: Uri): Boolean {
        if (uri.toString().length > MAX_AUTH_HANDOFF_URL_LENGTH) return false
        if (!uri.scheme.equals("https", ignoreCase = true) && !uri.scheme.equals("http", ignoreCase = true)) return false
        if (!uri.userInfo.isNullOrEmpty() || !uri.host.equals("accounts.google.com", ignoreCase = true)) return false
        return GOOGLE_INTERACTIVE_SIGNIN_PATH.containsMatchIn(uri.encodedPath ?: "/")
    }

    private fun isSystemBrowserAuthUrl(uri: Uri): Boolean {
        if (uri.toString().length > MAX_AUTH_HANDOFF_URL_LENGTH) return false
        if (!uri.scheme.equals("https", ignoreCase = true) && !uri.scheme.equals("http", ignoreCase = true)) return false
        if (!uri.userInfo.isNullOrEmpty()) return false
        val host = uri.host?.lowercase() ?: return false
        if (host == "accounts.google.com") {
            val path = uri.encodedPath ?: "/"
            return GOOGLE_OAUTH_PATH.containsMatchIn(path) || GOOGLE_INTERACTIVE_SIGNIN_PATH.containsMatchIn(path)
        }
        return SYSTEM_BROWSER_AUTH_HOSTS.any { host == it || host.endsWith(".$it") }
    }

    private fun secureSystemBrowserAuthUrl(uri: Uri): String {
        if (!isSystemBrowserAuthUrl(uri)) return uri.toString()
        val host = uri.host?.lowercase()
        val path = uri.encodedPath ?: "/"
        if (host == "accounts.google.com" && GOOGLE_REJECTED_SIGNIN_PATH.containsMatchIn(path)) {
            val builder = Uri.Builder()
                .scheme("https")
                .authority("accounts.google.com")
                .appendPath("ServiceLogin")
            val continuation = try { uri.getQueryParameter("continue") } catch (_: Exception) { null }
            if (!continuation.isNullOrEmpty() && continuation.length <= 4096) {
                val destination = try { Uri.parse(continuation) } catch (_: Exception) { null }
                if (destination != null
                    && destination.scheme.equals("https", ignoreCase = true)
                    && !destination.host.isNullOrEmpty()
                    && destination.userInfo.isNullOrEmpty()) {
                    builder.appendQueryParameter("continue", destination.buildUpon().fragment(null).build().toString())
                }
            }
            val language = try { uri.getQueryParameter("hl") } catch (_: Exception) { null }
            if (!language.isNullOrEmpty() && Regex("^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$").matches(language)) {
                builder.appendQueryParameter("hl", language)
            }
            return builder.build().toString()
        }
        return uri.buildUpon().scheme("https").fragment(null).build().toString()
    }

    private fun emitEvent(id: String, type: String, extra: (JSObject) -> Unit = {}) {
        val data = JSObject().put("id", id).put("type", type)
        try {
            extra(data)
        } catch (_: Exception) {
            // best-effort extras only
        }
        try {
            emit(data)
        } catch (_: Exception) {
            // listener gone - events are advisory
        }
    }

    private fun contentParent(): ViewGroup? =
        activity.findViewById(android.R.id.content) as? ViewGroup

    private fun layoutEntry(entry: TabEntry, x: Double, y: Double, width: Double, height: Double) {
        val anchorLeft = anchorView?.left ?: 0
        val anchorTop = anchorView?.top ?: 0
        val w = (width * density).toInt().coerceAtLeast(1)
        val h = (height * density).toInt().coerceAtLeast(1)
        val left = anchorLeft + (x * density).toInt()
        val top = anchorTop + (y * density).toInt()
        entry.webView.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.TOP or Gravity.START).apply {
            leftMargin = left
            topMargin = top
        }
        entry.snapshot.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.TOP or Gravity.START).apply {
            leftMargin = left
            topMargin = top
        }
    }

    /** Create (or reuse) the native webview for a tab and place it. */
    @SuppressLint("SetJavaScriptEnabled")
    fun attach(
        id: String,
        url: String?,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        pointerTheme: String = "system",
        pointerSize: String = "normal"
    ) {
        main.post {
            try {
                val parent = contentParent() ?: return@post
                var entry = tabs[id]
                if (entry == null) {
                    entry = TabEntry(id)
                    entry.snapshot = ImageView(activity).apply {
                        visibility = View.GONE
                        setBackgroundColor(Color.parseColor("#101218"))
                    }
                    entry.webView = WebView(activity).apply {
                        setBackgroundColor(Color.parseColor("#101218"))
                        isVerticalScrollBarEnabled = true
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.cacheMode = WebSettings.LOAD_DEFAULT
                        settings.setSupportMultipleWindows(true)
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                                val targetUri = request?.url ?: return false
                                if (request.isForMainFrame && isSystemBrowserAuthUrl(targetUri)) {
                                    // Cancel before the provider page is loaded.
                                    // A canceled WebView navigation is not
                                    // guaranteed to produce onPageFinished,
                                    // so stop the Yayra loader explicitly.
                                    // JS either preserves a third-party OAuth
                                    // URL in Capacitor Browser or starts
                                    // Yayra's own callback-returning Google
                                    // connection, leaving tab history intact.
                                    emitEvent(id, "loading-stop")
                                    if (isYayraGoogleAccountConnectionUrl(targetUri)) {
                                        // The raw ServiceLogin URL can contain
                                        // opaque continuation data. JS only
                                        // needs a first-party signal; never
                                        // send that captured URL across the
                                        // native bridge.
                                        emitEvent(id, "google-account-auth-required") { d -> d.put("reason", "android-navigation") }
                                    } else {
                                        emitEvent(id, "auth-navigation-blocked") { d -> d.put("url", secureSystemBrowserAuthUrl(targetUri)) }
                                    }
                                    return true
                                }
                                val target = targetUri.toString()
                                // Only web pages render in this engine; other
                                // schemes (mailto:, market:, intent:) stay off
                                // the app webview rather than half-working.
                                return !target.startsWith("http://") && !target.startsWith("https://")
                            }

                            override fun onPageStarted(view: WebView?, target: String?, favicon: Bitmap?) {
                                tabs[id]?.mainFrameFailed = false
                                emitEvent(id, "loading-start") { d -> d.put("url", target ?: "") }
                            }

                            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                                if (request?.isForMainFrame != true) return
                                val failedUrl = request.url?.toString() ?: view?.url ?: ""
                                tabs[id]?.mainFrameFailed = true
                                emitEvent(id, "fail-load") { d ->
                                    d.put("url", failedUrl)
                                    d.put("errorCode", error?.errorCode ?: -1)
                                    d.put("errorDescription", error?.description?.toString() ?: "net::ERR_FAILED")
                                }
                            }

                            override fun onPageFinished(view: WebView?, target: String?) {
                                val entryNow = tabs[id]
                                entryNow?.let {
                                    applyPointerThemeToPage(it)
                                    applyGradientTextCompatibility(it)
                                }
                                emitEvent(id, "loading-stop")
                                val finishedUrl = view?.url ?: target ?: ""
                                // Publish the final redirected URL first. BrowserShell can then
                                // validate the positive completion against that destination
                                // instead of mistaking a legitimate redirect for stale success.
                                emitEvent(id, "navigated") { d ->
                                    d.put("url", finishedUrl)
                                    d.put("canGoBack", view?.canGoBack() ?: false)
                                    d.put("canGoForward", view?.canGoForward() ?: false)
                                    d.put("isLoading", false)
                                }
                                if (entryNow?.mainFrameFailed != true) {
                                    emitEvent(id, "load-succeeded") { d -> d.put("url", finishedUrl) }
                                }
                                val title = view?.title
                                if (!title.isNullOrBlank()) {
                                    emitEvent(id, "title-updated") { d -> d.put("title", title) }
                                }
                            }

                            override fun doUpdateVisitedHistory(view: WebView?, target: String?, isReload: Boolean) {
                                // In-page link clicks (SPAs) never trigger
                                // onPageStarted - report address changes here
                                // so the omnibox stays truthful.
                                if (isReload || target == null) return
                                val entryNow = tabs[id] ?: return
                                if (target == entryNow.lastReportedUrl) return
                                entryNow.lastReportedUrl = target
                                emitEvent(id, "navigated") { d ->
                                    d.put("url", target)
                                    d.put("canGoBack", view?.canGoBack() ?: false)
                                    d.put("canGoForward", view?.canGoForward() ?: false)
                                    d.put("isLoading", true)
                                }
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onCreateWindow(parent: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
                                // Mirror Electron: user-initiated ordinary popups
                                // become Yayra tabs; matching Google OAuth and
                                // existing Apple/Microsoft auth popups are sent
                                // to the secure browser.
                                if (!isUserGesture || resultMsg == null) return false
                                var routed = false
                                lateinit var popup: WebView
                                fun routePopup(target: String) {
                                    if (target.equals("about:blank", ignoreCase = true) || routed) return
                                    routed = true
                                    val uri = try { Uri.parse(target) } catch (_: Exception) { null }
                                    if (uri != null && isYayraGoogleAccountConnectionUrl(uri)) {
                                        emitEvent(id, "google-account-auth-required") { d -> d.put("reason", "android-popup") }
                                    } else if (uri != null && isSystemBrowserAuthUrl(uri)) {
                                        emitEvent(id, "auth-navigation-blocked") { d -> d.put("url", secureSystemBrowserAuthUrl(uri)) }
                                    } else if (target.startsWith("http://", true) || target.startsWith("https://", true)) {
                                        emitEvent(id, "new-window-request") { d -> d.put("url", target) }
                                    }
                                    try { popup.stopLoading(); popup.destroy() } catch (_: Exception) { /* best effort */ }
                                }

                                popup = WebView(activity).apply {
                                    settings.javaScriptEnabled = true
                                    settings.domStorageEnabled = true
                                    settings.allowFileAccess = false
                                    settings.allowContentAccess = false
                                    webViewClient = object : WebViewClient() {
                                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                                            if (request?.isForMainFrame != true) return true
                                            val target = request.url.toString()
                                            if (target.equals("about:blank", ignoreCase = true)) return false
                                            routePopup(target)
                                            return true
                                        }

                                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                            if (!url.isNullOrBlank()) routePopup(url)
                                        }
                                    }
                                }
                                val transport = resultMsg.obj as? WebView.WebViewTransport ?: run {
                                    popup.destroy()
                                    return false
                                }
                                transport.webView = popup
                                resultMsg.sendToTarget()
                                main.postDelayed({
                                    if (!routed) {
                                        routed = true
                                        try { popup.stopLoading(); popup.destroy() } catch (_: Exception) { /* best effort */ }
                                    }
                                }, 30_000)
                                return true
                            }

                            override fun onCloseWindow(window: WebView?) {
                                try { window?.stopLoading(); window?.destroy() } catch (_: Exception) { /* best effort */ }
                            }
                        }
                    }
                    parent.addView(entry.snapshot)
                    parent.addView(entry.webView)
                    tabs[id] = entry
                }
                val activeEntry = entry ?: return@post
                val nextTheme = normalizedPointerTheme(pointerTheme)
                val nextSize = normalizedPointerSize(pointerSize)
                val pointerChanged = activeEntry.pointerTheme != nextTheme || activeEntry.pointerSize != nextSize
                activeEntry.pointerTheme = nextTheme
                activeEntry.pointerSize = nextSize
                if (pointerChanged && activeEntry.currentUrl != null) applyPointerThemeToPage(activeEntry)

                layoutEntry(activeEntry, x, y, width, height)
                if (!url.isNullOrBlank() && url != activeEntry.currentUrl) {
                    activeEntry.currentUrl = url
                    activeEntry.lastReportedUrl = url
                    activeEntry.webView.loadUrl(url)
                }
            } catch (err: Exception) {
                emitEvent(id, "engine-error") { d -> d.put("error", err.message ?: "attach-failed") }
            }
        }
    }

    /** Update the cursor immediately, including any already-open website tab. */
    fun setPointerTheme(id: String, theme: String, size: String) {
        main.post {
            val entry = tabs[id] ?: return@post
            val nextTheme = normalizedPointerTheme(theme)
            val nextSize = normalizedPointerSize(size)
            if (entry.pointerTheme == nextTheme && entry.pointerSize == nextSize) return@post
            entry.pointerTheme = nextTheme
            entry.pointerSize = nextSize
            applyPointerThemeToPage(entry)
        }
    }

    private fun normalizedPointerTheme(theme: String?): String =
        if (theme == "yayra" || theme == "high-visibility") theme else "system"

    private fun normalizedPointerSize(size: String?): String =
        if (size == "large" || size == "xlarge") size else "normal"

    private fun cursorData(svg: String, hotspotX: Int, hotspotY: Int, fallback: String): String {
        val encoded = Base64.encodeToString(svg.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        return "url('data:image/svg+xml;base64,$encoded') $hotspotX $hotspotY, $fallback"
    }

    private fun pointerCss(theme: String, size: String): String {
        val dimension = when (size) { "xlarge" -> 48; "large" -> 36; else -> 24 }
        val scale = dimension / 24.0
        val color = if (theme == "high-visibility") "#111a2e" else "#6d5df2"
        val outline = if (theme == "high-visibility") "#ffd400" else "#ffffff"
        val arrowStroke = if (theme == "high-visibility") 2.4 / scale else 1.6 / scale
        val handStroke = if (theme == "high-visibility") 2.4 / scale else 1.6 / scale
        val arrowSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"$dimension\" height=\"$dimension\" viewBox=\"0 0 24 24\"><path d=\"M5 2l14 10-6 1 3.5 7-2.6 1.2L10.5 14 5 18z\" fill=\"$color\" stroke=\"$outline\" stroke-width=\"$arrowStroke\" stroke-linejoin=\"round\"/></svg>"
        val handSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"$dimension\" height=\"$dimension\" viewBox=\"0 0 24 24\"><path d=\"M9 11V4.5a1.5 1.5 0 0 1 3 0V10l4.6.9c1.1.2 1.9 1.2 1.9 2.3v3.3c0 2.5-2 4.5-4.5 4.5h-3.4c-1.3 0-2.6-.6-3.4-1.7L4 15.5c-.6-.9-.4-2 .5-2.6.8-.5 1.9-.3 2.5.5l2 2.6z\" fill=\"$color\" stroke=\"$outline\" stroke-width=\"$handStroke\" stroke-linejoin=\"round\"/></svg>"
        val arrowCursor = cursorData(arrowSvg, (4 * scale).toInt(), (2 * scale).toInt(), "auto")
        val handCursor = cursorData(handSvg, (9 * scale).toInt(), (2 * scale).toInt(), "pointer")
        val interactiveSelector = ":where(" + listOf(
            "a", "area[href]", "button",
            "input[type='button']", "input[type='submit']", "input[type='reset']", "input[type='image']",
            "input[type='checkbox']", "input[type='radio']", "input[type='range']", "input[type='file']", "input[type='color']",
            "select", "option", "summary", "label",
            "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='menuitemcheckbox']", "[role='menuitemradio']",
            "[role='combobox']", "[role='listbox']", "[role='option']", "[role='checkbox']", "[role='radio']", "[role='switch']", "[role='slider']", "[role='treeitem']", "[role='gridcell']",
            "[aria-haspopup]", "[onclick]", "[tabindex]:not([tabindex='-1'])"
        ).joinToString(", ") + ")"
        // :not(html) gives this hand rule the same specificity as body * in
        // the arrow rule, without defeating the native text-cursor rules.
        val handTargetSelector = "$interactiveSelector:not(html)"
        return "html, body, body * { cursor: $arrowCursor !important; }\n" +
            "$handTargetSelector, $handTargetSelector * { cursor: $handCursor !important; }\n" +
            "input:not([type]), input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='tel'], input[type='password'], input[type='number'], input[type='date'], input[type='time'], input[type='datetime-local'], input[type='month'], input[type='week'], textarea, [contenteditable]:not([contenteditable='false']), [role='textbox'] { cursor: text !important; }\n" +
            "[data-yayra-selectable-text='true'] { cursor: text !important; user-select: text !important; -webkit-user-select: text !important; }"
    }

    /**
     * CSS cannot distinguish glyphs from blank padding inside a text-bearing
     * element. Hit-test the actual caret position so mouse/stylus users get an
     * I-beam and touch pointerdown can begin native WebView selection. Android
     * then supplies its standard contextual Copy/Cut/Share action mode.
     */
    private fun pointerTextScript(enabled: Boolean): String {
        if (!enabled) {
            return "(function(){try{window.__yayraTextPointerCleanup&&window.__yayraTextPointerCleanup();}catch(e){}})();"
        }
        val interactive = JSONObject.quote(listOf(
            "a", "area[href]", "button",
            "input[type='button']", "input[type='submit']", "input[type='reset']", "input[type='image']",
            "input[type='checkbox']", "input[type='radio']", "input[type='range']", "input[type='file']", "input[type='color']",
            "select", "option", "summary", "label",
            "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='combobox']",
            "[role='checkbox']", "[role='radio']", "[role='switch']", "[aria-haspopup]", "[onclick]", "[tabindex]:not([tabindex='-1'])"
        ).joinToString(", "))
        return "(function(){try{" +
            "window.__yayraTextPointerCleanup&&window.__yayraTextPointerCleanup();" +
            "var attr='data-yayra-selectable-text',selector=$interactive,current=null;" +
            "var clear=function(){try{current&&current.removeAttribute(attr);}catch(e){}current=null;};" +
            "var interactiveTarget=function(target){var el=target&&target.nodeType===1?target:target&&target.parentElement;try{while(el){if(el.closest&&el.closest(selector))return true;var root=el.getRootNode&&el.getRootNode();el=root&&root.host?root.host:null;}}catch(e){}return false;};" +
            "var hit=function(ev){if(!ev)return;if(ev.pointerType==='touch'&&ev.type!=='pointerdown')return;if(interactiveTarget(ev.target)){clear();return;}var range=null;try{if(document.caretRangeFromPoint)range=document.caretRangeFromPoint(ev.clientX,ev.clientY);else if(document.caretPositionFromPoint){var p=document.caretPositionFromPoint(ev.clientX,ev.clientY);if(p&&p.offsetNode){range=document.createRange();range.setStart(p.offsetNode,p.offset);range.collapse(true);}}}catch(e){}var node=range&&range.startContainer,el=node&&node.nodeType===3?node.parentElement:null;if(!el||!String(node.nodeValue||'').trim()||interactiveTarget(el)){clear();return;}try{var check=document.createRange();check.selectNodeContents(node);var rects=check.getClientRects(),ok=false;for(var i=0;i<rects.length;i++){var r=rects[i];if(ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom){ok=true;break;}}if(!ok){clear();return;}}catch(e){clear();return;}if(el===current)return;clear();try{el.setAttribute(attr,'true');current=el;}catch(e){}};" +
            "document.addEventListener('pointermove',hit,true);document.addEventListener('pointerdown',hit,true);" +
            "window.__yayraTextPointerCleanup=function(){document.removeEventListener('pointermove',hit,true);document.removeEventListener('pointerdown',hit,true);clear();try{delete window.__yayraTextPointerCleanup;}catch(e){}};" +
            "}catch(e){}})();"
    }

    private fun applyPointerThemeToPage(entry: TabEntry) {
        val customTheme = entry.pointerTheme != "system"
        val styleScript = if (!customTheme) {
            "(function(){try{window.__yayraPointerThemeObserver?.disconnect();delete window.__yayraPointerThemeObserver;document.getElementById('yayra-custom-pointer-theme')?.remove();}catch(e){}})();"
        } else {
            val css = JSONObject.quote(pointerCss(entry.pointerTheme, entry.pointerSize))
            "(function(){try{var id='yayra-custom-pointer-theme',css=$css;try{window.__yayraPointerThemeObserver?.disconnect();}catch(e){};var install=function(){var root=document.documentElement;if(!root)return;var style=document.getElementById(id);if(!style){style=document.createElement('style');style.id=id;}var nonceNode=root.querySelector('style[nonce],script[nonce]'),nonce=nonceNode&&(nonceNode.nonce||nonceNode.getAttribute('nonce'));if(nonce&&style.getAttribute('nonce')!==nonce)style.setAttribute('nonce',nonce);if(style.textContent!==css)style.textContent=css;var parent=document.head||root;if(style.parentNode!==parent)parent.appendChild(style);};install();if(typeof MutationObserver==='function'&&document.documentElement){var observer=new MutationObserver(install);observer.observe(document.documentElement,{childList:true,subtree:true});window.__yayraPointerThemeObserver=observer;}}catch(e){}})();"
        }
        val script = styleScript + pointerTextScript(customTheme)
        try { entry.webView.evaluateJavascript(script, null) } catch (_: Exception) { /* best-effort styling only */ }
    }

    /**
     * Repair the common gradient-text failure in embedded WebView builds:
     * transparent glyphs plus an unrecognised background-clip:text rule paint
     * a large gradient rectangle. The detector is deliberately limited to
     * gradient-text utility patterns and leaves opaque/decorative gradients
     * alone. It tries both clip spellings before choosing a contrast-safe
     * solid foreground, and observes bounded dynamic DOM/class updates.
     */
    private fun applyGradientTextCompatibility(entry: TabEntry) {
        val script = """
            (function(){try{
              var key='__yayraGradientTextCompatibilityV1';
              if(window[key]&&window[key].scan){window[key].scan(document);return;}
              var selector='.gradient-text,[class*="gradient-text"],[class~="bg-clip-text"],[class~="text-transparent"]';
              var parse=function(value){var match=String(value||'').toLowerCase().match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/);return match?[+match[1],+match[2],+match[3],match[4]===undefined?1:+match[4]]:null;};
              var transparent=function(value){var text=String(value||'').trim().toLowerCase(),color=parse(text);return text==='transparent'||!!(color&&color[3]<=0.05);};
              var luminance=function(color){if(!color)return -1;var total=[0.2126,0.7152,0.0722],result=0;for(var i=0;i<3;i++){var value=Math.max(0,Math.min(255,color[i]))/255;value=value<=0.04045?value/12.92:Math.pow((value+0.055)/1.055,2.4);result+=value*total[i];}return result;};
              var contrast=function(a,b){var first=luminance(a),second=luminance(b);return first<0||second<0?0:(Math.max(first,second)+0.05)/(Math.min(first,second)+0.05);};
              var background=function(element){for(var depth=0;element&&depth<8;depth++,element=element.parentElement){var color=parse(getComputedStyle(element).backgroundColor);if(color&&color[3]>0.05)return color;}return null;};
              var fallback=function(element){var surface=background(element),parent=element.parentElement;for(var depth=0;parent&&depth<6;depth++,parent=parent.parentElement){var value=getComputedStyle(parent).color,color=parse(value);if(color&&color[3]>0.5&&(!surface||contrast(color,surface)>=4.5))return value;}var level=luminance(surface);return level>=0&&level<0.179?'#ffffff':'#000000';};
              var properties=['background-image','background-color','background-clip','-webkit-background-clip','color','-webkit-text-fill-color'],originals=new WeakMap();
              var remember=function(element,classIntent){if(originals.has(element))return;var values={};for(var i=0;i<properties.length;i++){var property=properties[i];values[property]={value:element.style.getPropertyValue(property),priority:element.style.getPropertyPriority(property)};}originals.set(element,{values:values,classIntent:classIntent});};
              var restore=function(element){var original=originals.get(element);if(!original)return false;for(var i=0;i<properties.length;i++){var property=properties[i],saved=original.values[property];if(saved.value)element.style.setProperty(property,saved.value,saved.priority||'');else element.style.removeProperty(property);}element.removeAttribute('data-yayra-gradient-text');originals.delete(element);return true;};
              var repair=function(element){if(!element||!element.style)return false;var style=getComputedStyle(element),classes=' '+String(element.className&&element.className.baseVal||element.className||'').toLowerCase()+' ',classIntent=classes.indexOf('gradient-text')>=0||classes.indexOf(' bg-clip-text ')>=0,original=originals.get(element);if(original&&original.classIntent&&!classIntent)return restore(element);var image=String(style.backgroundImage||'');if(!/(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\s*\(/i.test(image))return false;var clip=[style.backgroundClip,style.webkitBackgroundClip].join(' ').toLowerCase(),intended=classIntent||clip.indexOf('text')>=0;if(!intended||!(transparent(style.color)||transparent(style.webkitTextFillColor)))return false;if(element.getAttribute('data-yayra-gradient-text')==='clip'&&clip.indexOf('text')>=0)return false;remember(element,classIntent);try{element.style.setProperty('-webkit-background-clip','text','important');element.style.setProperty('background-clip','text','important');var next=getComputedStyle(element),accepted=[next.backgroundClip,next.webkitBackgroundClip].join(' ').toLowerCase();if(accepted.indexOf('text')>=0){element.style.setProperty('-webkit-text-fill-color','currentColor','important');element.setAttribute('data-yayra-gradient-text','clip');return true;}}catch(error){}var solid=fallback(element);element.style.setProperty('background-image','none','important');element.style.setProperty('background-color','transparent','important');element.style.setProperty('background-clip','border-box','important');element.style.setProperty('-webkit-background-clip','border-box','important');element.style.setProperty('color',solid,'important');element.style.setProperty('-webkit-text-fill-color',solid,'important');element.setAttribute('data-yayra-gradient-text','solid');return true;};
              var scan=function(root){var nodes=[];try{if(root&&root.nodeType===1)nodes.push(root);if(root&&root.querySelectorAll)nodes=nodes.concat(Array.prototype.slice.call(root.querySelectorAll(selector),0,240));}catch(error){return;}for(var i=0;i<nodes.length&&i<240;i++)repair(nodes[i]);};
              var timer=0,schedule=function(){if(timer)return;timer=setTimeout(function(){timer=0;scan(document);},50);};
              var observer=typeof MutationObserver==='function'&&document.documentElement?new MutationObserver(function(records){var changed=false;for(var i=0;i<records.length;i++){var record=records[i];if(record.type==='attributes'){try{if(record.target&&record.target.matches&&(record.target.matches(selector)||record.target.getAttribute('data-yayra-gradient-text')))scan(record.target);}catch(error){}continue;}var added=record.addedNodes||[];for(var j=0;j<added.length;j++){changed=true;scan(added[j]);}}if(changed)schedule();}):null;
              if(observer)observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});
              window[key]={scan:scan,observer:observer};scan(document);setTimeout(function(){scan(document);},250);setTimeout(function(){scan(document);},1000);
            }catch(error){}})();
        """.trimIndent()
        try { entry.webView.evaluateJavascript(script, null) } catch (_: Exception) { /* best-effort website compatibility */ }
    }

    /** Reposition/resize (CSS px) - follows the DOM slot on every layout. */
    fun update(id: String, x: Double, y: Double, width: Double, height: Double) {
        main.post {
            val entry = tabs[id] ?: return@post
            layoutEntry(entry, x, y, width, height)
        }
    }

    /**
     * Show/hide. Hiding CAPTURES the current frame into an ImageView first,
     * so opening Yayra's drawer/modals over the page keeps the page visually
     * present underneath the chrome instead of flashing an empty void.
     */
    fun setVisible(id: String, visible: Boolean) {
        main.post {
            val entry = tabs[id] ?: return@post
            if (visible) {
                entry.snapshot.visibility = View.GONE
                entry.webView.visibility = View.VISIBLE
                return@post
            }
            try {
                if (entry.webView.visibility == View.VISIBLE && entry.webView.width > 0 && entry.webView.height > 0) {
                    val bitmap = Bitmap.createBitmap(entry.webView.width, entry.webView.height, Bitmap.Config.ARGB_8888)
                    entry.webView.draw(Canvas(bitmap))
                    entry.snapshot.setImageBitmap(bitmap)
                    entry.snapshot.visibility = View.VISIBLE
                }
            } catch (_: Exception) {
                // capture is cosmetic - hiding still proceeds
            }
            entry.webView.visibility = View.INVISIBLE
        }
    }

    /** Navigate the tab's webview (same engine, new address). */
    fun navigate(id: String, url: String) {
        main.post {
            val entry = tabs[id] ?: return@post
            entry.currentUrl = url
            entry.lastReportedUrl = url
            entry.webView.loadUrl(url)
        }
    }

    fun goBack(id: String) {
        main.post {
            val entry = tabs[id] ?: return@post
            if (entry.webView.canGoBack()) entry.webView.goBack()
        }
    }

    fun goForward(id: String) {
        main.post {
            val entry = tabs[id] ?: return@post
            if (entry.webView.canGoForward()) entry.webView.goForward()
        }
    }

    fun reload(id: String, retainedUrl: String? = null) {
        main.post {
            val entry = tabs[id] ?: return@post
            val target = retainedUrl?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
            if (target != null) {
                // Like desktop Chromium, Android WebView is not guaranteed to
                // commit a disconnected navigation. Retry the JS-retained URL
                // explicitly instead of risking reload() of the prior page.
                entry.currentUrl = target
                entry.lastReportedUrl = target
                entry.mainFrameFailed = false
                entry.webView.loadUrl(target)
            } else {
                entry.webView.reload()
            }
        }
    }

    fun stop(id: String) {
        main.post {
            tabs[id]?.webView?.stopLoading()
        }
    }

    fun canGoBack(id: String): Boolean {
        val entry = tabs[id] ?: return false
        return try { entry.webView.canGoBack() } catch (_: Exception) { false }
    }

    /** Destroy one tab's engine (tab closed / navigated off the engine). */
    fun remove(id: String) {
        main.post {
            val entry = tabs.remove(id) ?: return@post
            try {
                (entry.webView.parent as? ViewGroup)?.removeView(entry.webView)
                entry.webView.destroy()
            } catch (_: Exception) {
                // already detached
            }
            try {
                (entry.snapshot.parent as? ViewGroup)?.removeView(entry.snapshot)
            } catch (_: Exception) {
                // already detached
            }
        }
    }

    /** Destroy every engine (app teardown / profile switch). */
    fun removeAll() {
        val ids = ArrayList(tabs.keys)
        for (tabId in ids) remove(tabId)
    }
}
