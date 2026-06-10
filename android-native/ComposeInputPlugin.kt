/*
 * Native compose-bar plugin.
 *
 * The EditText + Send button defined in bridge_layout_main.xml are a
 * NATIVE Android input, sitting below the WebView. We type into it
 * instead of the WebView's hidden textarea because Android WebView has
 * an unfixable Chromium bug: editing CJK / non-Latin text in the
 * middle of a web <input>/<textarea> snaps the caret to the end
 * (confirmed open Capacitor/Chromium issue; JS selection-restore
 * doesn't help — it's below the JS layer). A native EditText uses
 * Android's own text editing and handles mid-text CJK insertion
 * correctly.
 *
 * JS drives it:
 *   setActive(true/false)  — show/hide the bar (per terminal tab)
 *   clear()                — empty it after a submit
 *   insertNewline()        — keybar ⏎ inserts a newline at the caret
 *   focus()                — pop the keyboard
 * and listens for:
 *   submit { text }        — Send tapped → renderer writes it to the PTY
 */
package app.claudesessions.android

import android.widget.Button
import android.widget.EditText
import android.view.View
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ComposeInput")
class ComposeInputPlugin : Plugin() {

    private var bar: View? = null
    private var edit: EditText? = null
    private var sendBtn: Button? = null
    private var wired = false

    override fun load() {
        // Views live in the activity's content view (our overridden
        // bridge_layout_main.xml). Resolve them by the resource ids.
        val act = activity ?: return
        val res = act.resources
        val pkg = act.packageName
        bar = act.findViewById(res.getIdentifier("compose_bar", "id", pkg))
        edit = act.findViewById(res.getIdentifier("compose_input", "id", pkg))
        sendBtn = act.findViewById(res.getIdentifier("compose_send", "id", pkg))
        android.util.Log.i("ClaudeCompose",
            "load: bar=${bar != null} edit=${edit != null} send=${sendBtn != null}")
        wire()
    }

    private fun wire() {
        if (wired) return
        val e = edit ?: return
        val b = sendBtn ?: return
        b.setOnClickListener { submitCurrent() }
        // Long-press Send = wipe the whole box. The keybar's Clr does
        // this for the program's line (Ctrl+U); this is the equivalent
        // "delete everything I typed" for the compose box itself.
        b.setOnLongClickListener { e.setText(""); true }

        // Make the EditText reliably focus + raise the keyboard on tap.
        // With a WebView as the primary view, a plain EditText tap
        // sometimes doesn't pop the IME on its own, so we force it.
        e.isFocusable = true
        e.isFocusableInTouchMode = true
        e.setOnClickListener { showKeyboardOn(e) }
        e.setOnFocusChangeListener { _, hasFocus -> if (hasFocus) showKeyboardOn(e) }

        // Keep the bar above the gesture-nav bar when the keyboard is
        // down (adjustResize handles the keyboard-up case).
        bar?.let { barView ->
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(barView) { v, insets ->
                val nav = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.navigationBars() or
                        androidx.core.view.WindowInsetsCompat.Type.ime()
                ).bottom
                v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, nav)
                insets
            }
        }
        wired = true
    }

    private fun showKeyboardOn(v: View) {
        v.requestFocus()
        val imm = activity?.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
            as? android.view.inputmethod.InputMethodManager
        imm?.showSoftInput(v, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }

    private fun submitCurrent() {
        val e = edit ?: return
        val text = e.text?.toString() ?: ""
        val ev = JSObject().apply { put("text", text) }
        notifyListeners("submit", ev)
        // Deliberately NOT clearing here. The JS side calls clear()
        // after the PTY write succeeds; clearing eagerly meant a dead
        // tab / failed write silently ate the user's message.
    }

    @PluginMethod
    fun setActive(call: PluginCall) {
        val show = call.getBoolean("active", false) == true
        activity?.runOnUiThread {
            // Re-resolve views lazily in case load() ran before the
            // content view was fully inflated.
            if (bar == null || edit == null) load()
            bar?.visibility = if (show) View.VISIBLE else View.GONE
            android.util.Log.i("ClaudeCompose", "setActive($show) bar=${bar != null}")
        }
        call.resolve()
    }

    // JS can query whether the native bar actually wired up; if not
    // (e.g. the layout override didn't apply), it falls back to the
    // in-page compose box.
    @PluginMethod
    fun isReady(call: PluginCall) {
        call.resolve(JSObject().apply { put("ready", bar != null && edit != null) })
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        activity?.runOnUiThread { edit?.setText("") }
        call.resolve()
    }

    @PluginMethod
    fun insertNewline(call: PluginCall) {
        activity?.runOnUiThread {
            val e = edit ?: return@runOnUiThread
            val start = e.selectionStart.coerceAtLeast(0)
            val end = e.selectionEnd.coerceAtLeast(start)
            e.text?.replace(start, end, "\n")
            e.setSelection((start + 1).coerceAtMost(e.text?.length ?: 0))
        }
        call.resolve()
    }

    @PluginMethod
    fun focus(call: PluginCall) {
        activity?.runOnUiThread {
            val e = edit ?: return@runOnUiThread
            e.requestFocus()
            val imm = activity?.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
                as? android.view.inputmethod.InputMethodManager
            imm?.showSoftInput(e, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
        call.resolve()
    }
}
