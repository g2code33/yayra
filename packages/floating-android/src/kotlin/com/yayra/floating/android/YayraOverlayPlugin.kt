package com.yayra.floating.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.speech.RecognizerIntent
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebSettings
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
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
@CapacitorPlugin(
    name = "YayraOverlay",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
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
        tabWeb()?.reload(id, call.getString("url"))
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
        // Do not enter the speech recognizer until Android has shown its real
        // runtime permission prompt and the user has explicitly approved it.
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "googleVoiceMicrophonePermissionResult")
            return
        }
        launchGoogleVoiceSearch(call)
    }

    @PermissionCallback
    private fun googleVoiceMicrophonePermissionResult(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.resolve(JSObject().put("ok", false).put("reason", "not-allowed"))
            return
        }
        launchGoogleVoiceSearch(call)
    }

    private fun launchGoogleVoiceSearch(call: PluginCall) {
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

    private fun isGoogleLensResultUrl(value: String): Boolean {
        return try {
            val parsed = Uri.parse(value)
            val host = parsed.host.orEmpty().lowercase(Locale.US)
            val path = parsed.path.orEmpty().trimEnd('/').ifEmpty { "/" }
            val googleHost = host == "google.com" || host.endsWith(".google.com")
            val emptyLensHome = host == "lens.google.com" &&
                (path == "/" || path == "/v3/upload" || path == "/uploadbyurl")
            val emptyGooglePicker = (host == "google.com" || host == "www.google.com") &&
                path == "/" && (parsed.queryParameterNames.contains("olud") || parsed.queryParameterNames.isEmpty())
            parsed.scheme == "https" && googleHost && host != "accounts.google.com" &&
                !emptyLensHome && !emptyGooglePicker
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Direct Android -> Google Lens upload. File bytes use a multipart POST;
     * public image links use Google's upload-by-URL GET endpoint. Redirects
     * are deliberately not followed here: the exact completed result URL is
     * returned to the active Yayra tab, while an empty `?olud=` picker is
     * rejected so the renderer can retain the original selection for retry.
     */
    @PluginMethod
    fun googleLensUpload(call: PluginCall) {
        val remoteImageUrl = call.getString("imageUrl")?.trim().orEmpty()
        val encoded = call.getString("data")
        val mimeType = (call.getString("type") ?: "").lowercase(Locale.US)
        val supportedTypes = setOf(
            "image/bmp", "image/jpeg", "image/png", "image/tiff", "image/webp", "image/x-icon"
        )
        val safeRemoteUrl = if (remoteImageUrl.isNotEmpty()) {
            try {
                val parsed = URL(remoteImageUrl)
                if ((parsed.protocol == "http" || parsed.protocol == "https") &&
                    parsed.userInfo == null && remoteImageUrl.length <= 2000
                ) parsed.toString() else null
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        if (remoteImageUrl.isNotEmpty() && safeRemoteUrl == null) {
            call.resolve(JSObject().put("ok", false).put("reason", "invalid-image-url"))
            return
        }
        val encodedImage = if (safeRemoteUrl == null) encoded?.takeIf { it.isNotBlank() } else null
        if (safeRemoteUrl == null && encodedImage == null) {
            call.resolve(JSObject().put("ok", false).put("reason", "empty-file"))
            return
        }
        // A 20 MB binary payload is at most 27,962,028 Base64 characters.
        // Reject before decoding so a compromised renderer cannot force a
        // much larger temporary allocation in the native process.
        if (encodedImage != null && encodedImage.length > 27_962_028) {
            call.resolve(JSObject().put("ok", false).put("reason", "file-too-large"))
            return
        }
        if (safeRemoteUrl == null && !supportedTypes.contains(mimeType)) {
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
                val bytes = encodedImage?.let { Base64.decode(it, Base64.DEFAULT) }
                if (bytes != null && (bytes.isEmpty() || bytes.size > 20 * 1024 * 1024)) {
                    hostActivity.runOnUiThread {
                        call.resolve(JSObject().put("ok", false).put("reason", "file-too-large"))
                    }
                    return@Thread
                }

                val metrics = context.resources.displayMetrics
                val viewportWidth = (call.getInt("viewportWidth") ?: metrics.widthPixels).coerceIn(1, 100_000)
                val viewportHeight = (call.getInt("viewportHeight") ?: metrics.heightPixels).coerceIn(1, 100_000)
                var imageWidth = (call.getInt("width") ?: 0).coerceIn(0, 100_000)
                var imageHeight = (call.getInt("height") ?: 0).coerceIn(0, 100_000)
                if (bytes != null && (imageWidth == 0 || imageHeight == 0)) {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    if (bounds.outWidth > 0 && bounds.outHeight > 0) {
                        imageWidth = bounds.outWidth.coerceAtMost(100_000)
                        imageHeight = bounds.outHeight.coerceAtMost(100_000)
                    }
                }

                val startedAt = (call.getLong("startedAt") ?: System.currentTimeMillis()).toString()
                val commonQuery = "ep=ccm&hl=${URLEncoder.encode(language, "UTF-8")}" +
                    "&vpw=$viewportWidth&vph=$viewportHeight" +
                    "&st=${URLEncoder.encode(startedAt, "UTF-8")}"
                val endpoint = if (safeRemoteUrl != null) {
                    URL("https://lens.google.com/uploadbyurl?$commonQuery&url=${URLEncoder.encode(safeRemoteUrl, "UTF-8")}")
                } else {
                    URL("https://lens.google.com/v3/upload?$commonQuery")
                }
                val boundary = "----YayraLens${UUID.randomUUID().toString().replace("-", "")}"
                connection = (endpoint.openConnection() as HttpURLConnection).apply {
                    requestMethod = if (safeRemoteUrl != null) "GET" else "POST"
                    doOutput = safeRemoteUrl == null
                    instanceFollowRedirects = false
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    if (safeRemoteUrl == null) {
                        setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                    }
                    setRequestProperty("Accept", "text/html,application/xhtml+xml")
                    setRequestProperty("Accept-Language", language)
                    setRequestProperty("User-Agent", userAgent)
                    val cookies = CookieManager.getInstance().getCookie(endpoint.toString())
                    if (!cookies.isNullOrBlank()) setRequestProperty("Cookie", cookies)
                }
                if (bytes != null) {
                    DataOutputStream(BufferedOutputStream(connection.outputStream)).use { output ->
                        output.writeBytes("--$boundary\r\n")
                        output.writeBytes("Content-Disposition: form-data; name=\"encoded_image\"; filename=\"$safeName\"\r\n")
                        output.writeBytes("Content-Type: $mimeType\r\n\r\n")
                        output.write(bytes)
                        output.writeBytes("\r\n")
                        if (imageWidth > 0 && imageHeight > 0) {
                            output.writeBytes("--$boundary\r\n")
                            output.writeBytes("Content-Disposition: form-data; name=\"processed_image_dimensions\"\r\n\r\n")
                            output.writeBytes("$imageWidth,$imageHeight\r\n")
                        }
                        output.writeBytes("--$boundary--\r\n")
                        output.flush()
                    }
                }

                val status = connection.responseCode
                for ((header, values) in connection.headerFields) {
                    if (header?.equals("Set-Cookie", ignoreCase = true) != true) continue
                    for (cookie in values.orEmpty()) {
                        CookieManager.getInstance().setCookie(endpoint.toString(), cookie)
                    }
                }
                CookieManager.getInstance().flush()
                val location = connection.getHeaderField("Location")
                val resultUrl = if (!location.isNullOrBlank()) URL(endpoint, location).toString() else connection.url.toString()
                val googleResult = status in 200..399 && isGoogleLensResultUrl(resultUrl)
                hostActivity.runOnUiThread {
                    if (googleResult) {
                        call.resolve(JSObject().put("ok", true).put("url", resultUrl))
                    } else {
                        val reason = if (resultUrl.contains("olud=")) "google-no-result" else "google-http-$status"
                        call.resolve(JSObject().put("ok", false).put("reason", reason))
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
        val providedIconDataUrl = call.getString("iconDataUrl")
        val providedIconUrl = call.getString("iconUrl")
        // RFC 3986, not application/x-www-form-urlencoded: URLEncoder
        // encodes a space as '+', which the JS side's decodeURIComponent
        // leaves as a literal '+', mangling the deep-linked site URL.
        // Replacing the '+' with %20 makes the encoding round-trip exactly.
        val encoded = java.net.URLEncoder.encode(url, "UTF-8").replace("+", "%20")
        val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("com.yayra.app:/browse?url=$encoded")).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        // SITE LOGO ON THE HOME SCREEN: prefer manifest/page-declared art,
        // then the live tab favicon and conventional locations off the
        // main thread. Truly iconless sites receive a deterministic
        // origin-derived identicon—never Yayra's application resource.
        Thread {
            val downloadedBitmap = try {
                fetchFaviconBitmap(url, providedIconDataUrl, providedIconUrl)
            } catch (err: Exception) {
                null
            }
            val generatedIcon = downloadedBitmap == null
            val siteBitmap = downloadedBitmap ?: generateSiteIdentityBitmap(url)
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    if (siteBitmap == null) {
                        call.resolve(JSObject().put("ok", false).put("reason", "site-identity-unavailable"))
                        return@post
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        val shortcutManager = context.getSystemService(ShortcutManager::class.java)
                        if (shortcutManager != null && shortcutManager.isRequestPinShortcutSupported) {
                            val shortcutId = "yayra-site-${url.hashCode()}"
                            val shortcut = ShortcutInfo.Builder(context, shortcutId)
                                .setShortLabel(title.take(10))
                                .setLongLabel(title.take(40))
                                .setIcon(Icon.createWithBitmap(siteBitmap))
                                .setIntent(launchIntent)
                                .build()
                            // Re-running Install repairs an older pinned shortcut
                            // that carried Yayra's logo instead of duplicating it.
                            val alreadyPinned = shortcutManager.pinnedShortcuts.any { it.id == shortcutId }
                            if (alreadyPinned) {
                                shortcutManager.updateShortcuts(listOf(shortcut))
                                call.resolve(JSObject().put("ok", true).put("method", "updated-shortcut").put("generatedIcon", generatedIcon))
                                return@post
                            }
                            shortcutManager.requestPinShortcut(shortcut, null)
                            call.resolve(JSObject().put("ok", true).put("method", "pinned-shortcut").put("generatedIcon", generatedIcon))
                            return@post
                        }
                    }
                    // Legacy path (pre-Android-8 or launchers without pin support):
                    // the INSTALL_SHORTCUT broadcast carries the same verified
                    // site bitmap and never an application-resource fallback.
                    val broadcast = Intent("com.android.launcher.action.INSTALL_SHORTCUT").apply {
                        putExtra(Intent.EXTRA_SHORTCUT_NAME, title)
                        putExtra(Intent.EXTRA_SHORTCUT_INTENT, launchIntent)
                        putExtra(Intent.EXTRA_SHORTCUT_ICON, siteBitmap)
                    }
                    context.sendBroadcast(broadcast)
                    call.resolve(JSObject().put("ok", true).put("method", "legacy-broadcast").put("generatedIcon", generatedIcon))
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

    private fun htmlAttribute(tag: String, name: String): String {
        val escaped = Regex.escape(name)
        val match = Regex(
            """\b$escaped\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'<>]+))""",
            RegexOption.IGNORE_CASE
        ).find(tag) ?: return ""
        return match.groupValues.drop(1).firstOrNull { it.isNotEmpty() } ?: ""
    }

    private fun absoluteHttpUrl(base: String, candidate: String?): String? {
        if (candidate.isNullOrBlank()) return null
        return try {
            val resolved = java.net.URI(base).resolve(candidate.trim())
            if (resolved.scheme == "http" || resolved.scheme == "https") resolved.toString() else null
        } catch (err: Exception) {
            null
        }
    }

    private fun fetchIconBytes(target: String, maxBytes: Int): ByteArray? {
        var conn: java.net.HttpURLConnection? = null
        return try {
            val parsed = java.net.URL(target)
            if (parsed.protocol != "http" && parsed.protocol != "https") return null
            conn = parsed.openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36")
            conn.setRequestProperty("Accept", "image/*,application/manifest+json,text/html;q=0.8,*/*;q=0.5")
            if (conn.responseCode !in 200..299) return null
            if (conn.contentLength > maxBytes) return null
            val output = java.io.ByteArrayOutputStream()
            conn.inputStream.use { input ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    if (output.size() > maxBytes) return null
                }
            }
            output.toByteArray().takeIf { it.isNotEmpty() }
        } catch (err: Exception) {
            null
        } finally {
            try { conn?.disconnect() } catch (_err: Exception) { }
        }
    }

    private fun littleEndianInt(bytes: ByteArray, offset: Int): Int {
        if (offset < 0 || offset + 4 > bytes.size) return -1
        return (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)
    }

    /** Modern ICO files usually embed their best entry as a normal PNG. */
    private fun embeddedPngFromIco(bytes: ByteArray): ByteArray? {
        if (bytes.size < 22 || bytes[0].toInt() != 0 || bytes[1].toInt() != 0 ||
            (bytes[2].toInt() and 0xff) != 1 || bytes[3].toInt() != 0
        ) return null
        val count = (bytes[4].toInt() and 0xff) or ((bytes[5].toInt() and 0xff) shl 8)
        if (count <= 0 || count > 128 || 6 + (count * 16) > bytes.size) return null
        var best: ByteArray? = null
        var bestArea = -1
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        for (index in 0 until count) {
            val entry = 6 + (index * 16)
            val width = (bytes[entry].toInt() and 0xff).let { if (it == 0) 256 else it }
            val height = (bytes[entry + 1].toInt() and 0xff).let { if (it == 0) 256 else it }
            val length = littleEndianInt(bytes, entry + 8)
            val offset = littleEndianInt(bytes, entry + 12)
            if (length <= signature.size || offset < 0 || offset.toLong() + length.toLong() > bytes.size.toLong()) continue
            var png = true
            for (byteIndex in signature.indices) {
                if (bytes[offset + byteIndex] != signature[byteIndex]) { png = false; break }
            }
            if (!png || width * height <= bestArea) continue
            best = bytes.copyOfRange(offset, offset + length)
            bestArea = width * height
        }
        return best
    }

    /** Decode untrusted favicon bytes at a launcher-safe memory/dimension cap. */
    private fun decodeSiteBitmap(input: ByteArray): Bitmap? {
        if (input.isEmpty() || input.size > 2_000_000) return null
        val bytes = embeddedPngFromIco(input) ?: input
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0 || width > 32_768 || height > 32_768) return null
        var sample = 1
        while (maxOf(width, height) / sample > 1024) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(
            bytes,
            0,
            bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample }
        ) ?: return null
        val maxDimension = maxOf(decoded.width, decoded.height)
        if (maxDimension <= 512) return decoded
        val scale = 512.0 / maxDimension.toDouble()
        val scaled = Bitmap.createScaledBitmap(
            decoded,
            (decoded.width * scale).toInt().coerceAtLeast(1),
            (decoded.height * scale).toInt().coerceAtLeast(1),
            true
        )
        if (scaled !== decoded) decoded.recycle()
        return scaled
    }

    /** Stable, neutral fallback for a site that publishes no decodable art. */
    private fun generateSiteIdentityBitmap(siteUrl: String): Bitmap? {
        return try {
            val parsed = java.net.URI(siteUrl)
            val scheme = parsed.scheme?.lowercase(Locale.US) ?: return null
            val authority = parsed.rawAuthority?.lowercase(Locale.US) ?: return null
            if (scheme != "http" && scheme != "https") return null
            val digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest("$scheme://$authority".toByteArray(Charsets.UTF_8))
            val hue = ((((digest[0].toInt() and 0xff) shl 8) or (digest[1].toInt() and 0xff)) % 360).toFloat()
            val background = Color.HSVToColor(floatArrayOf(hue, 0.62f, 0.58f))
            val foreground = Color.HSVToColor(floatArrayOf((hue + 165f) % 360f, 0.38f, 0.98f))
            val accent = Color.HSVToColor(floatArrayOf((hue + 38f) % 360f, 0.72f, 0.92f))
            val size = 256
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
            paint.color = background
            canvas.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 46f, 46f, paint)

            val margin = 48f
            val gap = 5f
            val cell = (size - (margin * 2f) - (gap * 4f)) / 5f
            for (row in 0 until 5) {
                for (sourceColumn in 0 until 3) {
                    val digestIndex = 5 + (row * 3) + sourceColumn
                    val value = digest[digestIndex].toInt() and 0xff
                    if ((value and 1) == 0) continue
                    val columns = if (sourceColumn == 2) intArrayOf(2) else intArrayOf(sourceColumn, 4 - sourceColumn)
                    paint.color = if ((value and 2) == 2) accent else foreground
                    for (column in columns) {
                        val left = margin + (column * (cell + gap))
                        val top = margin + (row * (cell + gap))
                        canvas.drawRoundRect(RectF(left, top, left + cell, top + cell), 4f, 4f, paint)
                    }
                }
            }
            bitmap
        } catch (err: Exception) {
            null
        }
    }

    private fun decodeProvidedIcon(dataUrl: String?): Bitmap? {
        if (dataUrl.isNullOrBlank() || dataUrl.length > 4_000_000) return null
        return try {
            if (!dataUrl.startsWith("data:image/", ignoreCase = true)) return null
            val comma = dataUrl.indexOf(',')
            if (comma < 0 || !dataUrl.substring(0, comma).contains(";base64", ignoreCase = true)) return null
            val bytes = android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT)
            decodeSiteBitmap(bytes)
        } catch (err: Exception) {
            null
        }
    }

    /**
     * Resolve the site's own launcher bitmap from the live tab, Web App
     * Manifest, HTML icon links, conventional favicon names, or a final
     * favicon mirror. Returning null asks the caller for an origin-derived
     * neutral identicon; it never selects Yayra's bundled application logo.
     */
    private fun fetchFaviconBitmap(
        siteUrl: String?,
        providedIconDataUrl: String?,
        providedIconUrl: String?
    ): android.graphics.Bitmap? {
        if (siteUrl == null) return null
        val providedBitmap = decodeProvidedIcon(providedIconDataUrl)

        return try {
            val siteUri = java.net.URI(siteUrl)
            val host = siteUri.host ?: return null
            val authority = siteUri.rawAuthority ?: host
            val candidates = mutableListOf<String>()
            fun add(candidate: String?) {
                val resolved = absoluteHttpUrl(siteUrl, candidate) ?: return
                if (!candidates.contains(resolved)) candidates.add(resolved)
            }

            val pageBytes = fetchIconBytes(siteUrl, 768_000)
            val html = pageBytes?.toString(Charsets.UTF_8) ?: ""
            val linkTags = Regex("""<link\b[^>]*>""", RegexOption.IGNORE_CASE)
                .findAll(html.take(768_000)).map { it.value }.toList()

            // Manifest icons are the site's explicit installed-app identity.
            val manifestHref = linkTags.firstNotNullOfOrNull { tag ->
                val rel = htmlAttribute(tag, "rel").lowercase().split(Regex("""\s+"""))
                if (rel.contains("manifest")) htmlAttribute(tag, "href").ifBlank { null } else null
            }
            val manifestUrl = absoluteHttpUrl(siteUrl, manifestHref)
            if (manifestUrl != null) {
                val manifestText = fetchIconBytes(manifestUrl, 512_000)?.toString(Charsets.UTF_8)
                if (!manifestText.isNullOrBlank()) {
                    try {
                        val icons = org.json.JSONObject(manifestText).optJSONArray("icons")
                        val ranked = mutableListOf<Pair<Int, String>>()
                        if (icons != null) {
                            for (index in 0 until icons.length()) {
                                val icon = icons.optJSONObject(index) ?: continue
                                val src = icon.optString("src")
                                val purpose = icon.optString("purpose", "any").lowercase()
                                if (src.isBlank() || (purpose.contains("monochrome") && !purpose.contains("any") && !purpose.contains("maskable"))) continue
                                val absolute = absoluteHttpUrl(manifestUrl, src) ?: continue
                                val size = Regex("""(\d+)\s*x\s*(\d+)""").findAll(icon.optString("sizes"))
                                    .map { match -> match.groupValues[1].toIntOrNull()?.times(match.groupValues[2].toIntOrNull() ?: 0) ?: 0 }
                                    .maxOrNull() ?: 0
                                ranked.add(Pair(size, absolute))
                            }
                        }
                        ranked.sortedByDescending { it.first }.take(12).forEach { add(it.second) }
                    } catch (_err: Exception) { /* malformed manifest: continue */ }
                }
            }

            // Non-PWA pages still own their declared favicon/touch icon.
            val htmlIcons = mutableListOf<Pair<Int, String>>()
            linkTags.forEach { tag ->
                val rel = htmlAttribute(tag, "rel").lowercase().split(Regex("""\s+"""))
                if (!rel.contains("icon") && !rel.contains("apple-touch-icon")) return@forEach
                val href = absoluteHttpUrl(siteUrl, htmlAttribute(tag, "href")) ?: return@forEach
                val sizes = htmlAttribute(tag, "sizes")
                val score = Regex("""(\d+)\s*x\s*(\d+)""").find(sizes)?.groupValues?.get(1)?.toIntOrNull()
                    ?: if (rel.contains("apple-touch-icon")) 180 else 32
                htmlIcons.add(Pair(score, href))
            }
            htmlIcons.sortedByDescending { it.first }.take(8).forEach { add(it.second) }

            // Manifest launcher art and declared touch/favicons outrank the
            // live Chromium favicon supplied by the tab, matching PWA rules.
            for (candidate in candidates) {
                val bytes = fetchIconBytes(candidate, 2_000_000) ?: continue
                val bitmap = decodeSiteBitmap(bytes)
                if (bitmap != null) return bitmap
            }
            providedBitmap?.let { return it }
            val declaredCount = candidates.size
            add(providedIconUrl)
            add("${siteUri.scheme}://$authority/favicon.ico")
            add("${siteUri.scheme}://$authority/favicon.png")
            add("${siteUri.scheme}://$authority/apple-touch-icon.png")
            val origin = "${siteUri.scheme}://$authority"
            val encodedOrigin = java.net.URLEncoder.encode(origin, "UTF-8")
            add("https://www.google.com/s2/favicons?domain_url=$encodedOrigin&sz=256")

            for (index in declaredCount until candidates.size) {
                val bytes = fetchIconBytes(candidates[index], 2_000_000) ?: continue
                val bitmap = decodeSiteBitmap(bytes)
                if (bitmap != null) return bitmap
            }
            null
        } catch (err: Exception) {
            null
        }
    }
}
