/*
 * InputConnection wrapper that intercepts IME / soft-keyboard input
 * destined for the WebView and reroutes it to the active terminal
 * PTY via InputRouter.
 *
 * Why this exists:
 *
 *   xterm.js's hidden helper-textarea is the standard pattern in
 *   browser-based terminal emulators — but Android WebView's
 *   InputConnection (the bridge between the OS-level IME and the
 *   focused web input) silently drops composition / batched-input
 *   events when delivering to that textarea. Chinese Pinyin commits
 *   land nowhere, Gboard English autocomplete commits land nowhere,
 *   and only slow-typed single ASCII chars get through. The bug is
 *   inside WebView itself; no CSS / DOM-event listening fixes it.
 *
 *   This is exactly the problem Termux solved by NOT being a
 *   WebView app — Termux's TerminalView returns its own
 *   BaseInputConnection that handles commitText() directly. We
 *   stay in WebView land but apply the same trick: subclass
 *   WebView, override onCreateInputConnection, wrap the WebView's
 *   default IC with this class.
 *
 * Routing rule:
 *
 *   - When a terminal tab is active AND modal/editor is closed,
 *     InputRouter.isActive == true. We intercept commitText,
 *     sendKeyEvent, and deleteSurroundingText, then forward the
 *     bytes to the PTY backing the active tab.
 *
 *   - Otherwise (no tab, modal open, session editor focused),
 *     InputRouter.isActive == false. We delegate everything to the
 *     wrapped (WebView-default) IC so normal form inputs — Host,
 *     Username, Password etc. in the session editor — keep working
 *     as native browser fields.
 *
 *   JS pushes the active-tab state via Plugins.LocalShell.set-
 *   ActiveTab / Plugins.SSH.setActiveTab whenever the tab focus
 *   changes or the editor modal opens / closes.
 */
package app.claudesessions.android

import android.view.KeyEvent
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper

// VT/ANSI byte constants. Kotlin string literals don't accept \x1b
// — must use .  is ASCII DEL (what most shells expect
// for "Backspace" via cooked-mode line discipline).
private const val ESC = ""
private const val DEL = ""

class TerminalInputConnection(target: InputConnection) :
    InputConnectionWrapper(target, /*mutable=*/ true) {

    /** Final committed text from an IME composition (or a typed
     *  ASCII char with no composition). This is the canonical
     *  capture point — Chinese 你好 from Pinyin lands here as a
     *  single commitText("你好", …) call. */
    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        android.util.Log.i("ClaudeIME",
            "commitText len=${text.length} active=${InputRouter.isActive} text=${textPreview(text)}")
        if (InputRouter.isActive && text.isNotEmpty()) {
            InputRouter.send(text.toString())
            return true
        }
        return super.commitText(text, newCursorPosition)
    }

    private fun textPreview(s: CharSequence): String {
        val str = s.toString()
        return if (str.length <= 16) str else str.take(16) + "…"
    }

    /** Composition in progress (e.g. user is mid-Pinyin, candidate
     *  window open). Deliberately NOT routed — the IME will call
     *  commitText with the finalized text once a candidate is
     *  picked. Forwarding composition previews to the PTY would
     *  flood the shell prompt with intermediate Pinyin keystrokes. */
    override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
        return super.setComposingText(text, newCursorPosition)
    }

    override fun finishComposingText(): Boolean {
        return super.finishComposingText()
    }

    /** Raw key events (Enter, Backspace, arrows, hardware keyboard
     *  keystrokes). Map to standard terminal escape sequences /
     *  control bytes and forward. Modifier-less ASCII letters also
     *  arrive here from some IMEs; we forward them too. */
    override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (InputRouter.isActive && event.action == KeyEvent.ACTION_DOWN) {
            val out = mapKey(event)
            if (out != null) {
                InputRouter.send(out)
                return true
            }
        }
        return super.sendKeyEvent(event)
    }

    /** Some IMEs use this for backspace instead of sendKeyEvent. */
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (InputRouter.isActive) {
            if (beforeLength > 0) InputRouter.send(DEL.repeat(beforeLength))
            // afterLength is forward-delete; PTYs rarely care so we
            // just drop it.
            return true
        }
        return super.deleteSurroundingText(beforeLength, afterLength)
    }

    private fun mapKey(e: KeyEvent): String? {
        when (e.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> return "\r"
            KeyEvent.KEYCODE_DEL -> return DEL                  // backspace
            KeyEvent.KEYCODE_FORWARD_DEL -> return "$ESC[3~"
            KeyEvent.KEYCODE_TAB -> return "\t"
            KeyEvent.KEYCODE_ESCAPE -> return ESC
            KeyEvent.KEYCODE_DPAD_UP -> return "$ESC[A"
            KeyEvent.KEYCODE_DPAD_DOWN -> return "$ESC[B"
            KeyEvent.KEYCODE_DPAD_RIGHT -> return "$ESC[C"
            KeyEvent.KEYCODE_DPAD_LEFT -> return "$ESC[D"
            KeyEvent.KEYCODE_MOVE_HOME -> return "$ESC[H"
            KeyEvent.KEYCODE_MOVE_END -> return "$ESC[F"
            KeyEvent.KEYCODE_PAGE_UP -> return "$ESC[5~"
            KeyEvent.KEYCODE_PAGE_DOWN -> return "$ESC[6~"
        }
        // Hardware keyboard letter / number keys: getUnicodeChar
        // resolves the keyCode + meta-state into the printable char
        // (e.g. shift+a -> 'A').
        val ch = e.getUnicodeChar(e.metaState)
        if (ch != 0) {
            // Ctrl-letter -> ASCII control char (Ctrl-C -> 0x03 etc.)
            if (e.isCtrlPressed && ch in 0x40..0x7E) {
                return (ch and 0x1F).toChar().toString()
            }
            return ch.toChar().toString()
        }
        return null
    }
}
