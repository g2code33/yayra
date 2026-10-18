package com.yayra.floating.android

import android.app.Activity
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.speech.RecognizerIntent
import android.util.Base64
import android.webkit.WebSettings
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale
import java.util.UUID

/**
 * Capacitor bridge for Yayra's REAL system-wide floating bubble on Android.
 *
 * This is the missing link between the web shell (BrowserShell.js) and the
 * native overlay stack that already lives in this package:
 *   - YayraOverlayPermissionHelper - SYSTEM_ALERT_WINDOW runtime permission
 *   - YayraFloatBubbleService      - user-controlled foreground Service
 *   - YayraFloatBubbleManager      - WindowManager TYPE_APPLICATION_OVERLAY
 *
 * With the "Display over other apps" permission granted, the bubble is a
 * true OS-level overlay (same mechanism as Messenger chat heads): it floats
 * above EVERY other application, the launcher and the home screen - not
 * just inside Yayra's own WebView.
 *
 * Registered in MainActivity by scripts/ensure-capacitor-platform.mjs,
 * which also injects the required permissions + <service> entry into
 * AndroidManifest.xml and copies these Kotlin sources into the generated
 * android/ project on every `npm run build:android`.
 *
 * JS surface (feature-detected via window.Capacitor.Plugins.YayraOverlay):
 *   isSupported()       -> { supported: true }
 *   hasPermission()     -> { granted: boolean }
 *   requestPermission() -> opens the system "Display over other apps" page
 *                          for this app; resolves { granted: <current> }
 *                          (Android grants it in Settings, not via dialog)
 *   show()              -> starts the foreground service + bubble overlay
 *   hide()              -> stops the service and removes the bubble
 */
@CapacitorPlugin(name = "YayraOverlay")
class YayraOverlayPlugin : Plugin() {

    private fun googleLanguage(value: String?): String {
        val requested = (value ?: Locale.getDefault().toLanguageTag()).trim()
        return if (Regex("^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$").matches(requested)) requested else "en-US"
    }

    // In-app native tab webview engine (see YayraTabWebviewManager): real
    // WebViews layered inside Yayra's own window so frame-hostile sites
    // (Google, YouTube, X, ...) render IN the app instead of handing off
    // to Chrome Custom Tabs. No overlay permission required.
    private var tabWebManager: YayraTabWebviewManager? = null

    private fun tabWeb(): YayraTabWebviewManager? {
        if (tabWebManager == null) {
            try {
                val activity = bridge?.activity ?: return null
                tabWebManager = YayraTabWebviewManager(activity, bridge?.webView) { data ->
                    notifyListeners("tabWebEvent", data)
                }
            } catch (_: Exception) {
                return null
            }
        }
        return tabWebManager
    }

    @PluginMethod
    fun tabWebAttach(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        val manager = tabWeb() ?: run { call.reject("engine-unavailable"); return }
        // attach() always creates/updates the engine (failures surface as
        // tabWebEvent engine-error notifications) - never capture its Unit
        // return as a value.
        manager.attach(
            id,
            call.getString("url"),
            call.getDouble("x") ?: 0.0,
            call.getDouble("y") ?: 0.0,
            call.getDouble("width") ?: 0.0,
            call.getDouble("height") ?: 0.0,
            call.getString("pointerTheme") ?: "system",
            call.getString("pointerSize") ?: "normal"
        )
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebUpdate(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.update(
            id,
            call.getDouble("x") ?: 0.0,
            call.getDouble("y") ?: 0.0,
            call.getDouble("width") ?: 0.0,
            call.getDouble("height") ?: 0.0
        )
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebSetVisible(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        // PluginCall.getBoolean(String, Boolean) is @Nullable in Capacitor 8
        // (Type mismatch: inferred type is Boolean? but Boolean was expected
        // - killed the whole v1.0.39 Android release build). Elvis back to
        // true: unspecified means show, matching the JS call sites.
        tabWeb()?.setVisible(id, call.getBoolean("visible", true) ?: true)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebSetPointerTheme(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.setPointerTheme(
            id,
            call.getString("theme") ?: "system",
            call.getString("size") ?: "normal"
        )
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebNavigate(call: PluginCall) {
        val id = call.getString("id")
        val url = call.getString("url")
        if (id.isNullOrBlank() || url.isNullOrBlank()) { call.reject("id-and-url-required"); return }
        tabWeb()?.navigate(id, url)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebGoBack(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.goBack(id)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebGoForward(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.goForward(id)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebReload(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.reload(id)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebStop(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.stop(id)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun tabWebRemove(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrBlank()) { call.reject("id-required"); return }
        tabWeb()?.remove(id)
        call.resolve(JSObject().put("ok", true))
    }

    /**
     * Android WebView does not reliably expose Chromium's Web Speech API.
     * Launch Android's real speech-recognizer activity (Google Speech
     * Services on standard Android devices), return only the transcript,
     * and let the JS shell hand that text directly to Google Search.
     */
    @PluginMethod
    fun googleVoiceSearch(call: PluginCall) {
        val language = googleLanguage(call.getString("language"))
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak now")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        if (intent.resolveActivity(context.packageManager) == null) {
            call.resolve(JSObject().put("ok", false).put("reason", "recognizer-unavailable"))
            return
        }
        startActivityForResult(call, intent, "googleVoiceSearchResult")
    }

    @ActivityCallback
    private fun googleVoiceSearchResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) {
            call.resolve(JSObject().put("ok", false).put("canceled", true))
            return
        }
        val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        val transcript = matches?.firstOrNull()?.trim().orEmpty()
        if (transcript.isEmpty()) {
            call.resolve(JSObject().put("ok", false).put("reason", "no-speech"))
            return
        }
        call.resolve(JSObject().put("ok", true).put("transcript", transcript))
    }

    /**
     * Direct Android -> Google Lens multipart upload. This avoids WebView
     * popup/CORS limitations and does not involve any Yayra server.
     */
    @PluginMethod
    fun googleLensUpload(call: PluginCall) {
        val encoded = call.getString("data")
        val mimeType = (call.getString("type") ?: "").lowercase(Locale.US)
        val supportedTypes = setOf(
            "image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp", "image/x-icon"
        )
        if (encoded.isNullOrBlank()) {
            call.resolve(JSObject().put("ok", false).put("reason", "empty-file"))
            return
        }
        // A 20 MB binary payload is at most 27,962,028 Base64 characters.
        // Reject before decoding so a compromised renderer cannot force a
        // much larger temporary allocation in the native process.
        if (encoded.length > 27_962_028) {
            call.resolve(JSObject().put("ok", false).put("reason", "file-too-large"))
            return
        }
        if (!supportedTypes.contains(mimeType)) {
            call.resolve(JSObject().put("ok", false).put("reason", "unsupported-file-type"))
            return
        }
        val language = googleLanguage(call.getString("language"))
        val rawName = (call.getString("name") ?: "lens-upload").take(120)
        val safeName = rawName.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]+"), "-").ifBlank { "lens-upload" }
        val userAgent = try {
            WebSettings.getDefaultUserAgent(context)
        } catch (_: Exception) {
            "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome Mobile Safari/537.36"
        }
        val hostActivity = activity
        if (hostActivity == null) {
            call.resolve(JSObject().put("ok", false).put("reason", "activity-unavailable"))
            return
        }

        Thread {
            var connection: HttpURLConnection? = null
            try {
                val bytes = Base64.decode(encoded, Base64.DEFAULT)
                if (bytes.isEmpty() || bytes.size > 20 * 1024 * 1024) {
                    hostActivity.runOnUiThread {
                        call.resolve(JSObject().put("ok", false).put("reason", "file-too-large"))
                    }
                    return@Thread
                }
                val startedAt = (call.getLong("startedAt") ?: System.currentTimeMillis()).toString()
                val query = "ep=cntpubb&hl=${URLEncoder.encode(language, "UTF-8")}" +
                    "&st=${URLEncoder.encode(startedAt, "UTF-8")}&re=df&s=4"
                val endpoint = URL("https://lens.google.com/v3/upload?$query")
                val boundary = "----YayraLens${UUID.randomUUID().toString().replace("-", "")}"
                connection = (endpoint.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    instanceFollowRedirects = true
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                    setRequestProperty("Accept", "text/html,application/xhtml+xml")
                    setRequestProperty("Accept-Language", language)
                    setRequestProperty("User-Agent", userAgent)
                }
                DataOutputStream(BufferedOutputStream(connection.outputStream)).use { output ->
                    output.writeBytes("--$boundary\r\n")
                    output.writeBytes("Content-Disposition: form-data; name=\"encoded_image\"; filename=\"$safeName\"\r\n")
                    output.writeBytes("Content-Type: $mimeType\r\n\r\n")
                    output.write(bytes)
                    output.writeBytes("\r\n--$boundary--\r\n")
                    output.flush()
                }
                val status = connection.responseCode
                val location = connection.getHeaderField("Location")
                val resultUrl = if (!location.isNullOrBlank()) URL(endpoint, location).toString() else connection.url.toString()
                val googleResult = try {
                    val host = Uri.parse(resultUrl).host.orEmpty().lowercase(Locale.US)
                    resultUrl.startsWith("https://") && (host == "lens.google.com" || host.endsWith(".google.com"))
                } catch (_: Exception) {
                    false
                }
                hostActivity.runOnUiThread {
                    if (status in 200..399 && googleResult) {
                        call.resolve(JSObject().put("ok", true).put("url", resultUrl))
                    } else {
                        call.resolve(JSObject().put("ok", false).put("reason", "google-http-$status"))
                    }
                }
            } catch (err: Exception) {
                hostActivity.runOnUiThread {
                    call.resolve(JSObject().put("ok", false).put("reason", "upload-failed: ${err.message}"))
                }
            } finally {
                connection?.disconnect()
            }
        }.start()
    }

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val result = JSObject()
        result.put("supported", true)
        call.resolve(result)
    }

    @PluginMethod
    fun hasPermission(call: PluginCall) {
        val result = JSObject()
        result.put("granted", YayraOverlayPermissionHelper.canDrawOverlays(context))
        call.resolve(result)
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val granted = YayraOverlayPermissionHelper.canDrawOverlays(context)
        if (!granted) {
            try {
                val intent = YayraOverlayPermissionHelper.createPermissionIntent(context)
                context.startActivity(intent)
            } catch (err: Exception) {
                // Some OEM builds reject the package-specific page - fall
                // back to the general overlay-permission list.
                try {
                    context.startActivity(YayraOverlayPermissionHelper.createFallbackPermissionIntent())
                } catch (_err: Exception) {
                    call.reject("Could not open the overlay permission settings page")
                    return
                }
            }
        }
        val result = JSObject()
        result.put("granted", granted)
        call.resolve(result)
    }

    @PluginMethod
    fun show(call: PluginCall) {
        if (!YayraOverlayPermissionHelper.canDrawOverlays(context)) {
            call.reject("overlay-permission-not-granted")
            return
        }
        YayraFloatBubbleService.startService(context)
        call.resolve()
    }

    @PluginMethod
    fun hide(call: PluginCall) {
        YayraFloatBubbleService.stopService(context)
        call.resolve()
    }

    @PluginMethod
    fun minimizeApp(call: PluginCall) {
        // Convenience: minimize Yayra so the system bubble is immediately
        // floating over whatever the user switches to.
        val activity = activity
        if (activity != null) {
            activity.runOnUiThread { activity.moveTaskToBack(true) }
            call.resolve()
        } else {
            call.reject("no-activity")
        }
    }

    /**
     * Chrome-style "Install page as app..." on Android: a REAL launcher
     * entry (pinned home-screen shortcut) for the site. Tapping it
     * deep-links straight back INTO Yayra on that site via the existing
     * com.yayra.app custom-scheme intent filter
     * (com.yayra.app:/browse?url=...), exactly like a Chrome
     * "Add to Home screen" web app.
     */
    @PluginMethod
    fun installSiteAsApp(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("url-required")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("invalid-url")
            return
        }
        val title = (call.getString("title") ?: url).trim().ifEmpty { url }
        // RFC 3986, not application/x-www-form-urlencoded: URLEncoder
        // encodes a space as '+', which the JS side's decodeURIComponent
        // leaves as a literal '+', mangling the deep-linked site URL.
        // Replacing the '+' with %20 makes the encoding round-trip exactly.
        val encoded = java.net.URLEncoder.encode(url, "UTF-8").replace("+", "%20")
        val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("com.yayra.app:/browse?url=$encoded")).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        // SITE LOGO ON THE HOME SCREEN: fetch the site's own favicon OFF the
        // main thread (NetworkOnMainThreadException otherwise), then pin the
        // shortcut on the main thread with the site's bitmap when it
        // decoded, falling back to the Yayra bubble logo. Best effort only.
        Thread {
            val siteBitmap = try { fetchFaviconBitmap(url) } catch (err: Exception) { null }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val shortcutManager = context.getSystemService(ShortcutManager::class.java)
                        if (shortcutManager != null && shortcutManager.isRequestPinShortcutSupported) {
                            val icon = if (siteBitmap != null) {
                                Icon.createWithBitmap(siteBitmap)
                            } else {
                                val logoResId = context.resources.getIdentifier("yayra_bubble_logo", "drawable", context.packageName)
                                if (logoResId != 0) {
                                    Icon.createWithResource(context, logoResId)
                                } else {
                                    Icon.createWithResource(context, android.R.drawable.ic_menu_view)
                                }
                            }
                            val shortcut = ShortcutInfo.Builder(context, "yayra-site-${url.hashCode()}")
                                .setShortLabel(title.take(10))
                                .setLongLabel(title.take(40))
                                .setIcon(icon)
                                .setIntent(launchIntent)
                                .build()
                            shortcutManager.requestPinShortcut(shortcut, null)
                            call.resolve(JSObject().put("ok", true).put("method", "pinned-shortcut"))
                            return@post
                        }
                    }
                    // Legacy path (pre-Android-8 or launchers without pin support):
                    // the INSTALL_SHORTCUT broadcast (permission is declared in the
                    // manifest, injected by scripts/ensure-capacitor-platform.mjs).
                    val logoResId = context.resources.getIdentifier("yayra_bubble_logo", "drawable", context.packageName)
                    val broadcast = Intent("com.android.launcher.action.INSTALL_SHORTCUT").apply {
                        putExtra(Intent.EXTRA_SHORTCUT_NAME, title)
                        putExtra(Intent.EXTRA_SHORTCUT_INTENT, launchIntent)
                        if (siteBitmap != null) {
                            putExtra(Intent.EXTRA_SHORTCUT_ICON, siteBitmap)
                        } else if (logoResId != 0) {
                            putExtra(
                                Intent.EXTRA_SHORTCUT_ICON_RESOURCE,
                                Intent.ShortcutIconResource.fromContext(context, logoResId)
                            )
                        }
                    }
                    context.sendBroadcast(broadcast)
                    call.resolve(JSObject().put("ok", true).put("method", "legacy-broadcast"))
                } catch (err: Exception) {
                    call.reject("install-failed: ${err.message}")
                }
            }
        }.start()
    }

    /**
     * Opens a URL in YAYRA'S OWN native floating browser window (the real
     * WebView session hosted by YayraFloatBubbleService). Used for
     * "installed site" deep links on frame-hostile sites (Google, YouTube,
     * X, ...) which can never render inside the in-shell iframe engine:
     * a top-level native WebView navigation has no X-Frame-Options
     * restrictions, so the site truly opens - inside Yayra, not in an
     * external browser. Falls back honestly ({ok:false,
     * reason:"overlay-permission"}) when the "Display over other apps"
     * permission has not been granted, so the web layer can fall back to
     * the in-shell tab + secure browser view.
     */
    @PluginMethod
    fun openBrowserWindow(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("url-required")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("invalid-url")
            return
        }
        if (!YayraOverlayPermissionHelper.canDrawOverlays(context)) {
            call.resolve(JSObject().put("ok", false).put("reason", "overlay-permission"))
            return
        }
        try {
            YayraFloatBubbleService.openBrowserWindow(context, url)
            call.resolve(JSObject().put("ok", true).put("method", "floating-browser"))
        } catch (err: Exception) {
            call.reject("open-failed: ${err.message}")
        }
    }

    /**
     * Best-effort fetch + decode of the site's own favicon (PNG data served
     * at /favicon.ico decodes cleanly; true ICO containers may not - the
     * caller falls back to the Yayra logo). Time-boxed to 4s.
     */
    private fun fetchFaviconBitmap(siteUrl: String?): android.graphics.Bitmap? {
        if (siteUrl == null) return null
        return try {
            val host = java.net.URI(siteUrl).host ?: return null
            val conn = java.net.URL("https://$host/favicon.ico").openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 4000
            conn.readTimeout = 4000
            conn.instanceFollowRedirects = true
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return null
            }
            val bytes = conn.inputStream.use { it.readBytes() }
            conn.disconnect()
            if (bytes.isEmpty() || bytes.size > 512_000) return null
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (err: Exception) {
            null
        }
    }
}
