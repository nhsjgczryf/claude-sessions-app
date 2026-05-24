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
        wire()
    }

    private fun wire() {
        if (wired) return
        val e = edit ?: return
        val b = sendBtn ?: return
        b.setOnClickListener { submitCurrent() }
        wired = true
    }

    private fun submitCurrent() {
        val e = edit ?: return
        val text = e.text?.toString() ?: ""
        val ev = JSObject().apply { put("text", text) }
        notifyListeners("submit", ev)
        e.setText("")
    }

    @PluginMethod
    fun setActive(call: PluginCall) {
        val show = call.getBoolean("active", false) == true
        activity?.runOnUiThread {
            bar?.visibility = if (show) View.VISIBLE else View.GONE
        }
        call.resolve()
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
