package com.yayra.floating.android

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import com.getcapacitor.JSObject

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
 *   { id, type: 'loading-start' | 'loading-stop' | 'navigated' |
 *               'title-updated' | 'engine-error', url?, title?,
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

    private class TabEntry(val id: String) {
        lateinit var webView: WebView
        lateinit var snapshot: ImageView
        var currentUrl: String? = null
        var lastReportedUrl: String? = null
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
    fun attach(id: String, url: String?, x: Double, y: Double, width: Double, height: Double) {
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
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                                val target = request?.url?.toString() ?: return false
                                // Only web pages render in this engine; other
                                // schemes (mailto:, market:, intent:) stay off
                                // the app webview rather than half-working.
                                return !target.startsWith("http://") && !target.startsWith("https://")
                            }

                            override fun onPageStarted(view: WebView?, target: String?, favicon: Bitmap?) {
                                emitEvent(id, "loading-start") { d -> d.put("url", target ?: "") }
                            }

                            override fun onPageFinished(view: WebView?, target: String?) {
                                emitEvent(id, "loading-stop")
                                emitEvent(id, "navigated") { d ->
                                    d.put("url", view?.url ?: target ?: "")
                                    d.put("canGoBack", view?.canGoBack() ?: false)
                                    d.put("canGoForward", view?.canGoForward() ?: false)
                                    d.put("isLoading", false)
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
                        webChromeClient = WebChromeClient()
                    }
                    parent.addView(entry.snapshot)
                    parent.addView(entry.webView)
                    tabs[id] = entry
                }
                layoutEntry(entry, x, y, width, height)
                if (!url.isNullOrBlank() && url != entry.currentUrl) {
                    entry.currentUrl = url
                    entry.lastReportedUrl = url
                    entry.webView.loadUrl(url)
                }
            } catch (err: Exception) {
                emitEvent(id, "engine-error") { d -> d.put("error", err.message ?: "attach-failed") }
            }
        }
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

    fun reload(id: String) {
        main.post {
            tabs[id]?.webView?.reload()
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
