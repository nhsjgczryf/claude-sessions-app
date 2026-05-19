/*
 * Capacitor plugin that spawns a local PTY in the app's own process —
 * sibling to SshPlugin (which talks to remote SSH hosts via sshj).
 *
 * Phase 1 (this commit): execs Android's built-in /system/bin/sh as
 * a proof-of-concept that the JNI PTY plumbing works end-to-end. The
 * resulting shell is toybox-only — very limited, no bash, no package
 * manager — but it proves the architecture.
 *
 * Phase 2 will bundle a PRoot binary + Alpine Linux rootfs in the APK
 * assets and exec `proot -r <rootfs> /bin/sh` here instead, giving
 * the user a real Linux environment with apk / bash / tmux / nodejs.
 */
package app.claudesessions.android

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

@CapacitorPlugin(name = "LocalShell")
class LocalShellPlugin : Plugin() {

    private data class Entry(
        val tabId: String,
        val pid: Int,
        val masterFd: Int,
        @Volatile var alive: Boolean = true,
    )

    private val sessions = ConcurrentHashMap<String, Entry>()

    // ------------------------------------------------------------ connect

    @PluginMethod
    fun connect(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val cols = call.getInt("cols", 120)!!
        val rows = call.getInt("rows", 30)!!
        val initialCommand = call.getString("initialCommand")

        if (!Pty.isAvailable()) {
            return call.reject("native PTY library not loaded: ${Pty.loadError ?: "unknown"}")
        }
        if (sessions.containsKey(tabId)) {
            return call.reject("tabId already has a local shell session: $tabId")
        }

        // Phase 1: Android's /system/bin/sh. Tiny toybox shell — usable
        // for "does the PTY work" smoke testing, not for real work.
        // Phase 2 will replace argv with proot + alpine.
        val argv = arrayOf("/system/bin/sh")
        val filesDir = context.filesDir.absolutePath
        val env = arrayOf(
            "PATH=/system/bin:/system/xbin",
            "TERM=xterm-256color",
            "HOME=$filesDir",
            "TMPDIR=${context.cacheDir.absolutePath}",
            "LC_ALL=C.UTF-8",
            "LANG=C.UTF-8",
            "PS1=local$ ",
        )

        val result = try {
            Pty.forkPty(argv, env, filesDir, cols, rows)
        } catch (e: UnsatisfiedLinkError) {
            return call.reject("native PTY library missing: ${e.message}", e)
        } catch (e: Exception) {
            return call.reject("forkPty exception: ${e.message}", e)
        }

        if (result.size != 2 || result[0] < 0 || result[1] < 0) {
            return call.reject("forkPty failed (returned ${result.contentToString()})")
        }

        val masterFd = result[0]
        val pid = result[1]
        val entry = Entry(tabId, pid, masterFd, alive = true)
        sessions[tabId] = entry

        // Reader thread: drains the master FD and pushes UTF-8
        // strings back to JS until EOF. On EOF / error we wait for
        // the child to actually exit so we can report its exit code,
        // then emit 'exit'.
        thread(name = "local-pty-$tabId") {
            val buf = ByteArray(8192)
            try {
                while (entry.alive) {
                    val n = Pty.readPty(masterFd, buf, buf.size)
                    if (n <= 0) break
                    val data = String(buf, 0, n, StandardCharsets.UTF_8)
                    val ev = JSObject().apply {
                        put("tabId", tabId)
                        put("data", data)
                    }
                    notifyListeners("data", ev)
                }
            } catch (_: Throwable) {
                // Connection died — fall through to exit reporting.
            }
            val exitCode = try { Pty.waitForExit(pid) } catch (_: Throwable) { -1 }
            entry.alive = false
            sessions.remove(tabId)
            try { Pty.closeFd(masterFd) } catch (_: Throwable) {}
            val ev = JSObject().apply {
                put("tabId", tabId)
                put("exitCode", exitCode)
            }
            notifyListeners("exit", ev)
        }

        if (!initialCommand.isNullOrBlank()) {
            try {
                val data = (initialCommand + "\r").toByteArray(StandardCharsets.UTF_8)
                Pty.writePty(masterFd, data, 0, data.size)
            } catch (_: Throwable) {}
        }

        call.resolve(JSObject().apply { put("tabId", tabId) })
    }

    // ------------------------------------------------------------ write / resize / close

    @PluginMethod
    fun write(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val data = call.getString("data") ?: return call.reject("data required")
        val entry = sessions[tabId] ?: return call.reject("no session for tabId")
        try {
            val bytes = data.toByteArray(StandardCharsets.UTF_8)
            Pty.writePty(entry.masterFd, bytes, 0, bytes.size)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "write failed", e)
        }
    }

    @PluginMethod
    fun resize(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val cols = call.getInt("cols", 120)!!
        val rows = call.getInt("rows", 30)!!
        val entry = sessions[tabId] ?: return call.reject("no session for tabId")
        try {
            Pty.resizePty(entry.masterFd, cols, rows)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "resize failed", e)
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val entry = sessions[tabId] ?: return call.resolve()
        entry.alive = false
        try { Pty.killPid(entry.pid, 15 /* SIGTERM */) } catch (_: Throwable) {}
        // Don't close the FD here — let the reader thread observe EOF
        // naturally and clean up + emit 'exit'. Otherwise we'd race
        // between two threads closing the same fd.
        call.resolve()
    }
}
