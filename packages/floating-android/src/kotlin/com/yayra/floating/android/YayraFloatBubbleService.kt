package com.yayra.floating.android

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder
import android.webkit.WebView
import androidx.core.app.NotificationCompat

/**
 * User-controlled Foreground Service hosting both the Floating Bubble and
 * Resizable Floating Browser Window overlays on Android.
 * Enforces strict session preservation across Minimize, Restore, and Close cycles.
 */
class YayraFloatBubbleService : Service() {

    companion object {
        const val ACTION_START = "com.yayra.floating.action.START"
        const val ACTION_STOP = "com.yayra.floating.action.STOP"
        const val ACTION_OPEN_BROWSER = "com.yayra.floating.action.OPEN_BROWSER"
        const val ACTION_MINIMIZE_BROWSER = "com.yayra.floating.action.MINIMIZE_BROWSER"
        const val EXTRA_URL = "com.yayra.floating.extra.URL"
        const val NOTIFICATION_ID = 2001
        const val CHANNEL_ID = "yayra_floating_bubble_channel"

        fun startService(context: Context) {
            val intent = Intent(context, YayraFloatBubbleService::class.java).apply {
                action = ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Opens the floating browser window STRAIGHT ON a URL (used by
         * "installed site" home-screen shortcut deep links: the site must
         * actually open - a real WebView has no iframe/X-Frame-Options
         * restrictions, so Google, YouTube, X, ... all render fine here,
         * inside Yayra's own surface).
         */
        fun openBrowserWindow(context: Context, url: String) {
            val intent = Intent(context, YayraFloatBubbleService::class.java).apply {
                action = ACTION_OPEN_BROWSER
                putExtra(EXTRA_URL, url)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, YayraFloatBubbleService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    private var bubbleManager: YayraFloatBubbleManager? = null
    private var windowManager: YayraFloatingWindowManager? = null
    private var persistentWebView: WebView? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        if (action == ACTION_STOP) {
            stopFloatingExperience()
            return START_NOT_STICKY
        }

        // Verify overlay permission at runtime
        if (!YayraOverlayPermissionHelper.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Promote to Foreground Service with Android 14/15 type support
        val notification = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        initializeManagers()

        if (action == ACTION_OPEN_BROWSER) {
            restoreBrowserWindow()
            // Deep-linked "installed site": open straight on the site, not
            // on the yayra.app start page the persistent WebView boots on.
            val target = intent?.getStringExtra(EXTRA_URL)
            if (!target.isNullOrBlank()) {
                navigateBrowser(target)
            }
        } else {
            showBubbleOverlay()
        }

        return START_NOT_STICKY
    }

    private fun initializeManagers() {
        if (bubbleManager == null) {
            bubbleManager = YayraFloatBubbleManager(
                context = this,
                onBubbleTapListener = {
                    restoreBrowserWindow()
                },
                onQuickActionListener = { action ->
                    handleQuickAction(action)
                }
            )
        }

        if (windowManager == null) {
            windowManager = YayraFloatingWindowManager(
                context = this,
                onMinimizeCallback = {
                    minimizeBrowserWindow()
                },
                onCloseCallback = {
                    closeBrowserWindow()
                },
                onNavigateCallback = { url ->
                    navigateBrowser(url)
                }
            )
        }
    }

    // Interaction Rules Protocol
    private fun showBubbleOverlay() {
        windowManager?.hideBrowserWindow()
        bubbleManager?.showBubble()
    }

    private fun restoreBrowserWindow() {
        bubbleManager?.hideBubble()
        if (persistentWebView == null) {
            persistentWebView = createPersistentWebView()
        }
        windowManager?.showBrowserWindow(persistentWebView)
    }

    private fun minimizeBrowserWindow() {
        // Detach WebView to keep it alive without destroying DOM/JavaScript state
        windowManager?.hideBrowserWindow()
        bubbleManager?.showBubble()
    }

    private fun closeBrowserWindow() {
        // Return to bubble; do NOT stop entire service
        windowManager?.hideBrowserWindow()
        bubbleManager?.showBubble()
    }

    private fun navigateBrowser(url: String) {
        val target = if (url.startsWith("http://") || url.startsWith("https://")) {
            url
        } else {
            "https://duckduckgo.com/?q=${java.net.URLEncoder.encode(url, "UTF-8")}"
        }
        persistentWebView?.loadUrl(target)
    }

    private fun createPersistentWebView(): WebView {
        return WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
            }
            loadUrl("https://yayra.app")
        }
    }

    private fun handleQuickAction(action: YayraQuickActionsView.QuickAction) {
        when (action) {
            YayraQuickActionsView.QuickAction.NEW_TAB -> {
                persistentWebView?.loadUrl("https://duckduckgo.com")
                restoreBrowserWindow()
            }
            YayraQuickActionsView.QuickAction.SEARCH -> {
                restoreBrowserWindow()
            }
            YayraQuickActionsView.QuickAction.SETTINGS -> {
                persistentWebView?.loadUrl("yayra://settings")
                restoreBrowserWindow()
            }
            YayraQuickActionsView.QuickAction.CLOSE_BUBBLE -> {
                stopFloatingExperience()
            }
        }
    }

    private fun buildOngoingNotification(): Notification {
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPendingIntent = PendingIntent.getActivity(
            this, 0, openIntent ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, YayraFloatBubbleService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Yayra Floating Browser")
            .setContentText("Tap bubble or notification to expand floating window")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(android.R.drawable.ic_menu_view, "Open", openPendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Close", stopPendingIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Yayra Floating Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows status while Yayra floating overlays are active"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        bubbleManager?.onConfigurationChanged(newConfig)
        windowManager?.onConfigurationChanged(newConfig)
    }

    private fun stopFloatingExperience() {
        windowManager?.destroy()
        bubbleManager?.destroy()
        persistentWebView?.destroy()
        persistentWebView = null
        windowManager = null
        bubbleManager = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopFloatingExperience()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
