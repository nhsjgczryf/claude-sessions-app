/*
 * Process-singleton input router.
 *
 * The custom WebView's InputConnection (TerminalInputConnection)
 * doesn't know about Capacitor plugins, SSH sessions, or local PTYs
 * — it just intercepts IME commitText / sendKeyEvent calls and
 * forwards the resulting bytes here. Whichever plugin "owns" the
 * currently-active terminal tab installs a sender closure that knows
 * how to push bytes into that tab's PTY (local fd write, or SSH
 * outputStream write).
 *
 * Plugins set ownership-aware so the cross-plugin "I'm now inactive"
 * messages from JS can't accidentally wipe the OTHER plugin's
 * still-valid registration:
 *
 *   LocalShellPlugin.setActiveTab(t1)    → InputRouter.set("local", ...)
 *   SshPlugin.setActiveTab(null)         → clearIfOwnedBy("ssh")  no-op
 *
 * Without ownership tracking, the second call would clobber the
 * first because they share the same global slot.
 */
package app.claudesessions.android

object InputRouter {

    @Volatile private var _sender: ((String) -> Unit)? = null
    @Volatile private var _owner: String? = null

    val isActive: Boolean get() = _sender != null

    @Synchronized
    fun set(owner: String, fn: (String) -> Unit) {
        _sender = fn
        _owner = owner
    }

    @Synchronized
    fun clearIfOwnedBy(owner: String) {
        if (_owner == owner) {
            _sender = null
            _owner = null
        }
    }

    fun send(text: String) {
        // Snapshot so a concurrent clear doesn't NPE between the null
        // check and the invocation.
        val fn = _sender ?: return
        try { fn(text) } catch (t: Throwable) {
            android.util.Log.w("InputRouter", "send failed: ${t.message}")
        }
    }
}
