package com.yayra.floating.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.util.AttributeSet
import android.util.TypedValue
import android.view.*
import android.webkit.WebView
import android.widget.*

/**
 * Native Android Floating Browser Window View.
 * Provides a draggable glassmorphism titlebar, omnibox, browser controls,
 * WebView attachment container, and bottom-right resizing handle.
 */
@SuppressLint("ClickableViewAccessibility")
class YayraFloatingBrowserWindowView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : FrameLayout(context, attrs, defStyleAttr) {

    interface WindowInteractionListener {
        fun onWindowMove(deltaX: Float, deltaY: Float)
        fun onWindowResize(deltaWidth: Float, deltaHeight: Float)
        fun onMinimizeClicked()
        fun onMaximizeClicked()
        fun onCloseClicked()
        fun onNavigateRequested(url: String)
        fun onBackClicked()
        fun onForwardClicked()
        fun onReloadClicked()
        fun onStopClicked()
    }

    var interactionListener: WindowInteractionListener? = null

    // Sizing constants (in DP)
    val minWidthPx = dpToPx(280)
    val minHeightPx = dpToPx(360)

    // UI Elements
    private lateinit var titleBar: LinearLayout
    private lateinit var omniboxInput: EditText
    private lateinit var progressBar: ProgressBar
    private lateinit var webViewContainer: FrameLayout
    private lateinit var resizeHandle: View
    private lateinit var btnBack: TextView
    private lateinit var btnFwd: TextView
    private lateinit var btnReload: TextView
    private lateinit var btnMinimize: TextView
    private lateinit var btnMaximize: TextView
    private lateinit var btnClose: TextView

    // Drag / Resize touch tracking
    private var lastTouchX = 0f
    private var lastTouchY = 0f

    init {
        setupLayout()
    }

    private fun setupLayout() {
        // Glassmorphism Window Container Background
        background = GradientDrawable().apply {
            setColor(Color.argb(225, 13, 23, 54))
            cornerRadius = dpToPx(18).toFloat()
            setStroke(dpToPx(1), Color.argb(80, 255, 255, 255))
        }
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, dpToPx(18).toFloat())
            }
        }
        clipToOutline = true

        val rootLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        }

        // 1. Draggable Title Bar
        titleBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dpToPx(12), dpToPx(8), dpToPx(8), dpToPx(8))
            setBackgroundColor(Color.argb(140, 6, 11, 25))

            setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        lastTouchX = event.rawX
                        lastTouchY = event.rawY
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = event.rawX - lastTouchX
                        val dy = event.rawY - lastTouchY
                        lastTouchX = event.rawX
                        lastTouchY = event.rawY
                        interactionListener?.onWindowMove(dx, dy)
                        true
                    }
                    else -> false
                }
            }
        }

        val titleText = TextView(context).apply {
            text = "Yayra FloatBrowse"
            setTextColor(Color.parseColor("#38bdf8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleBar.addView(titleText)

        // Titlebar action buttons
        btnMinimize = createTitleButton("−", Color.parseColor("#94a3b8")) { interactionListener?.onMinimizeClicked() }
        btnMaximize = createTitleButton("□", Color.parseColor("#94a3b8")) { interactionListener?.onMaximizeClicked() }
        btnClose = createTitleButton("×", Color.parseColor("#ef4444")) { interactionListener?.onCloseClicked() }

        titleBar.addView(btnMinimize)
        titleBar.addView(btnMaximize)
        titleBar.addView(btnClose)
        rootLayout.addView(titleBar)

        // 2. Navigation Toolbar & Omnibox
        val toolbar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dpToPx(8), dpToPx(6), dpToPx(8), dpToPx(6))
            setBackgroundColor(Color.argb(100, 13, 23, 54))
        }

        btnBack = createNavButton("←") { interactionListener?.onBackClicked() }
        btnFwd = createNavButton("→") { interactionListener?.onForwardClicked() }
        btnReload = createNavButton("↻") { interactionListener?.onReloadClicked() }
        toolbar.addView(btnBack)
        toolbar.addView(btnFwd)
        toolbar.addView(btnReload)

        // Omnibox Input
        omniboxInput = EditText(context).apply {
            hint = "Search or enter address..."
            setHintTextColor(Color.argb(120, 255, 255, 255))
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setSingleLine(true)
            setPadding(dpToPx(10), dpToPx(6), dpToPx(10), dpToPx(6))
            background = GradientDrawable().apply {
                setColor(Color.argb(180, 6, 11, 25))
                cornerRadius = dpToPx(8).toFloat()
                setStroke(dpToPx(1), Color.argb(60, 255, 255, 255))
            }
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(dpToPx(6), 0, dpToPx(6), 0)
            }
            setOnEditorActionListener { _, _, _ ->
                val text = omniboxInput.text.toString().trim()
                if (text.isNotEmpty()) {
                    interactionListener?.onNavigateRequested(text)
                }
                true
            }
        }
        toolbar.addView(omniboxInput)

        val btnGo = Button(context).apply {
            text = "Go"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(dpToPx(8), 0, dpToPx(8), 0)
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#06b6d4"))
                cornerRadius = dpToPx(6).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(dpToPx(44), dpToPx(32))
            setOnClickListener {
                val text = omniboxInput.text.toString().trim()
                if (text.isNotEmpty()) interactionListener?.onNavigateRequested(text)
            }
        }
        toolbar.addView(btnGo)
        rootLayout.addView(toolbar)

        // 3. Horizontal Loading Progress Bar
        progressBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            visibility = GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dpToPx(2)
            )
        }
        rootLayout.addView(progressBar)

        // 4. WebView Attachment Container
        webViewContainer = FrameLayout(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
            setBackgroundColor(Color.WHITE)
        }
        rootLayout.addView(webViewContainer)

        addView(rootLayout)

        // 5. Corner Resizing Handle (Bottom-Right)
        resizeHandle = View(context).apply {
            background = GradientDrawable().apply {
                setColor(Color.argb(180, 6, 182, 212))
                cornerRadius = dpToPx(4).toFloat()
            }
            val handleSize = dpToPx(22)
            val params = LayoutParams(handleSize, handleSize).apply {
                gravity = Gravity.BOTTOM or Gravity.END
            }
            layoutParams = params

            setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        lastTouchX = event.rawX
                        lastTouchY = event.rawY
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dw = event.rawX - lastTouchX
                        val dh = event.rawY - lastTouchY
                        lastTouchX = event.rawX
                        lastTouchY = event.rawY
                        interactionListener?.onWindowResize(dw, dh)
                        true
                    }
                    else -> false
                }
            }
        }
        addView(resizeHandle)
    }

    // WebView Attachment / Detachment Protocol (Zero Leaks & Session Preservation)
    fun attachWebView(webView: WebView) {
        // Ensure webView is unparented first
        (webView.parent as? ViewGroup)?.removeView(webView)
        webViewContainer.removeAllViews()
        val params = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        webViewContainer.addView(webView, params)
    }

    fun detachWebView(): WebView? {
        if (webViewContainer.childCount > 0) {
            val child = webViewContainer.getChildAt(0) as? WebView
            webViewContainer.removeView(child)
            return child
        }
        return null
    }

    fun setUrlText(url: String) {
        omniboxInput.setText(url)
    }

    fun setProgress(progress: Int) {
        progressBar.progress = progress
        progressBar.visibility = if (progress in 1..99) VISIBLE else GONE
    }

    fun setCanGoBack(canBack: Boolean) {
        btnBack.isEnabled = canBack
        btnBack.alpha = if (canBack) 1.0f else 0.4f
    }

    fun setCanGoForward(canForward: Boolean) {
        btnFwd.isEnabled = canForward
        btnFwd.alpha = if (canForward) 1.0f else 0.4f
    }

    // REAL VISIBLE GLYPHS: this used to build an ImageButton and create a
    // TextView with the label INSIDE apply {} - never attaching it to the
    // button. A backgroundless ImageButton with no image is INVISIBLE, so
    // the title-bar buttons (hide / expand / close) existed and clicked,
    // but nobody could see them. The button IS the TextView now.
    private fun createTitleButton(label: String, color: Int, onClick: () -> Unit): TextView {
        return TextView(context).apply {
            text = label
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = null
            setPadding(dpToPx(8), dpToPx(4), dpToPx(8), dpToPx(4))
            layoutParams = LinearLayout.LayoutParams(dpToPx(32), dpToPx(28))
            setOnClickListener { onClick() }
        }
    }

    // The `symbol` used to be silently ignored - the nav buttons rendered
    // as empty rounded rectangles with no arrows at all.
    private fun createNavButton(symbol: String, onClick: () -> Unit): TextView {
        return TextView(context).apply {
            text = symbol
            setTextColor(Color.parseColor("#e2e8f0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(Color.argb(50, 255, 255, 255))
                cornerRadius = dpToPx(6).toFloat()
            }
            setPadding(dpToPx(6), dpToPx(4), dpToPx(6), dpToPx(4))
            layoutParams = LinearLayout.LayoutParams(dpToPx(30), dpToPx(28)).apply {
                setMargins(0, 0, dpToPx(4), 0)
            }
            setOnClickListener { onClick() }
        }
    }

    private fun dpToPx(dp: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), resources.displayMetrics
        ).toInt()
    }
}
