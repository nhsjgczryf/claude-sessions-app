/*
 * WebView subclass whose only job is to wrap the InputConnection
 * the OS-level IME talks to. Wrapping makes Chinese / Japanese /
 * Korean IME input (and Gboard-style English autocomplete) actually
 * reach the terminal — see the long comment in
 * TerminalInputConnection.kt for the bug we're working around.
 *
 * This view is plugged into Capacitor's bridge layout via
 * res/layout/bridge_layout_main.xml — Capacitor finds it by its
 * @id/webview ID and uses it as if it were a stock WebView. All
 * regular WebView functionality (page load, JS bridge, plugin
 * messaging, scrolling) is inherited unchanged.
 */
package app.claudesessions.android

import android.content.Context
import android.util.AttributeSet
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView

class ClaudeSessionsWebView : WebView {
    constructor(context: Context) : super(context)
    constructor(context: Context, attrs: AttributeSet?) : super(context, attrs)
    constructor(context: Context, attrs: AttributeSet?, defStyleAttr: Int) :
        super(context, attrs, defStyleAttr)

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        // Ask WebView for its standard IC first. This is the IC that
        // the focused DOM element (form input, textarea, etc.) would
        // normally talk to. If it's null (no focused input), Android
        // wouldn't show an IME anyway, so we have nothing to wrap.
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        return TerminalInputConnection(base)
    }
}
