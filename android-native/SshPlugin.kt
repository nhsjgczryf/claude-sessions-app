/*
 * Capacitor plugin that wraps sshj so the WebView can drive real SSH
 * connections directly from the Android process — no VPS server in the
 * middle, no Termux dependency. Each connection lives in its own
 * thread; stdout/stderr bytes are funneled back to JS as 'data' events
 * keyed by tabId. The companion ForegroundService keeps the app
 * process alive when the user backgrounds the WebView so the
 * connections (and any tmux session attached over them) don't get
 * killed by Android's app lifecycle.
 */
package app.claudesessions.android

import android.content.Intent
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.File
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.security.Security
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

@CapacitorPlugin(name = "SSH")
class SshPlugin : Plugin() {

    companion object {
        // Android ships its own partial BouncyCastle under the same
        // "BC" provider name (the AndroidKeyStoreBCWorkaround variant).
        // That partial provider is missing several modern algorithms
        // including X25519, which means sshj's curve25519-sha256 KEX —
        // the default for any OpenSSH 7.0+ server — fails with:
        //
        //   TransportException: no such algorithm: X25519 for provider BC
        //
        // Fix: swap Android's partial BC out for the full provider
        // shipped in the sshj-transitive bcprov-jdk18on jar. Once. The
        // companion-object init runs the first time SshPlugin is
        // referenced, well before any connect() call.
        init {
            try {
                Security.removeProvider("BC")
                Security.insertProviderAt(BouncyCastleProvider(), 1)
            } catch (e: Throwable) {
                android.util.Log.e("SshPlugin", "BC provider swap failed: ${e.message}", e)
            }
        }
    }

    private data class Entry(
        val tabId: String,
        val client: SSHClient,
        val session: Session,
        val shell: Session.Shell,
        @Volatile var alive: Boolean = true,
    )

    // tabId -> live session. ConcurrentHashMap because the writer
    // thread (WebView main thread via the plugin) and the reader
    // thread per connection both touch it.
    private val sessions = ConcurrentHashMap<String, Entry>()

    // tabId -> client that's still in the middle of connect/auth.
    // Tracked separately so close() can interrupt a stuck handshake
    // (DNS timeout, refused TCP, slow auth) — without this the user
    // is stuck staring at "[connecting…]" with no way to cancel.
    private val pending = ConcurrentHashMap<String, SSHClient>()

    // Small helper for surfacing connect progress back to JS so the
    // user knows we're not frozen.
    private fun emitStatus(tabId: String, status: String) {
        val ev = JSObject().apply {
            put("tabId", tabId)
            put("status", status)
        }
        notifyListeners("status", ev)
    }

    // ------------------------------------------------------------ connect

    @PluginMethod
    fun connect(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val host = call.getString("host") ?: return call.reject("host required")
        val port = call.getInt("port", 22)!!
        val username = call.getString("username") ?: return call.reject("username required")
        val password = call.getString("password")
        val privateKey = call.getString("privateKey")           // PEM contents
        val privateKeyPassphrase = call.getString("privateKeyPassphrase")
        val cols = call.getInt("cols", 120)!!
        val rows = call.getInt("rows", 30)!!
        val initialCommand = call.getString("initialCommand")
        val portForwards = call.getArray("portForwards")        // array of "local:remoteHost:remotePort"

        if (sessions.containsKey(tabId) || pending.containsKey(tabId)) {
            return call.reject("tabId already has an active or pending session: $tabId")
        }

        // Do the connect on a background thread — sshj's blocking
        // socket ops would otherwise pin the WebView.
        thread(name = "ssh-connect-$tabId") {
            val client = SSHClient()
            pending[tabId] = client
            try {
                // TODO(security): persist a known_hosts file under
                // context.filesDir and verify against it. For the
                // first release we accept any host key — the
                // alternative is "first connection always fails until
                // user manually adds a fingerprint", which is worse
                // UX than the threat model warrants on a personal
                // sideloaded app.
                client.addHostKeyVerifier(PromiscuousVerifier())
                // 8s connect timeout: long enough for a roaming-LTE
                // SYN to complete, short enough that a wrong host /
                // closed port / dead VPN surfaces as a clear failure
                // before the user wonders if the app is hung.
                client.connectTimeout = 8_000
                client.timeout = 60_000
                emitStatus(tabId, "Connecting to $host:$port…")
                try {
                    client.connect(host, port)
                } catch (e: Exception) {
                    throw RuntimeException(
                        "TCP connect to $host:$port failed (${e.javaClass.simpleName}: ${e.message ?: "no message"})",
                        e,
                    )
                }

                // SSH-level keepalive. sshj sends a global-request ping
                // every 30s; after a few missed responses the connection
                // throws, which surfaces as our 'exit' event in JS. That
                // turns "wifi dropped mid-session" from "hangs forever
                // until TCP RST minutes later" into "exits within ~90s
                // and the auto-reconnect path kicks in".
                try {
                    client.connection.keepAlive.keepAliveInterval = 30
                } catch (_: Throwable) {}

                emitStatus(tabId, "Authenticating as $username…")
                // Auth: prefer key if both provided. sshj's auth*
                // methods throw on failure; we surface a clean
                // message rather than a stack trace.
                when {
                    !privateKey.isNullOrBlank() -> {
                        // loadKeys(String) treats the argument as a FILE
                        // PATH, not PEM contents — use the 3-arg overload
                        // that takes a key string + optional public key
                        // + optional PasswordFinder.
                        val finder = if (privateKeyPassphrase.isNullOrEmpty()) null
                        else net.schmizz.sshj.userauth.password.PasswordUtils
                            .createOneOff(privateKeyPassphrase.toCharArray())
                        val kp: KeyProvider = client.loadKeys(privateKey, null, finder)
                        client.authPublickey(username, kp)
                    }
                    !password.isNullOrEmpty() -> client.authPassword(username, password)
                    else -> throw IllegalArgumentException("either password or privateKey required")
                }

                // Open the optional local port forwards. We start
                // them in their own threads because sshj's
                // LocalPortForwarder.listen() blocks for the
                // lifetime of the forward.
                if (portForwards != null) {
                    for (i in 0 until portForwards.length()) {
                        val spec = portForwards.getString(i)
                        startPortForward(client, spec)
                    }
                }

                emitStatus(tabId, "Opening shell…")
                val session = client.startSession()
                // Allocate PTY via reflection so we don't bind to
                // sshj's PTYMode subpackage (which has shifted between
                // sshj versions). Empty modes map is fine — no flow
                // control / signal tweaks needed.
                Sshj.allocatePty(session, "xterm-256color", cols, rows)
                val shell = session.startShell()

                val entry = Entry(tabId, client, session, shell, alive = true)
                sessions[tabId] = entry
                pending.remove(tabId)

                // Apply initial size — sshj's resize method has been
                // renamed across versions (changeWindowDimensions vs
                // requestWindowChange). Sshj.resizePty tries both.
                Sshj.resizePty(session, cols, rows)

                // Reader: shovel shell stdout (which is merged with
                // stderr by the server when running interactively) to
                // JS. Use a byte->UTF8 decoding buffer so multi-byte
                // chars don't get split across notifications.
                thread(name = "ssh-reader-$tabId") {
                    val buf = ByteArray(8192)
                    try {
                        val stdin = shell.inputStream
                        while (entry.alive) {
                            val n = stdin.read(buf)
                            if (n < 0) break
                            if (n == 0) continue
                            val data = String(buf, 0, n, StandardCharsets.UTF_8)
                            val ev = JSObject().apply {
                                put("tabId", tabId)
                                put("data", data)
                            }
                            notifyListeners("data", ev)
                        }
                    } catch (e: Throwable) {
                        // Connection died — fall through to exit notify.
                    } finally {
                        emitExit(tabId, entry)
                    }
                }

                // Initial command (e.g., the tmux attach line built by JS).
                if (!initialCommand.isNullOrBlank()) {
                    try {
                        shell.outputStream.write((initialCommand + "\r").toByteArray(StandardCharsets.UTF_8))
                        shell.outputStream.flush()
                    } catch (_: Throwable) {}
                }

                // Keep the process alive in the background while at
                // least one SSH session is open.
                ensureForegroundService()

                emitStatus(tabId, "Ready")
                val ret = JSObject().apply { put("tabId", tabId) }
                call.resolve(ret)
            } catch (e: Exception) {
                pending.remove(tabId)
                try { client.disconnect() } catch (_: Throwable) {}
                // PluginCall.reject(String, Exception) requires
                // Exception (not Throwable); we caught Exception to
                // satisfy that overload. Errors (OOM etc.) bubble up
                // and crash the plugin thread, which is the right
                // behavior — we don't want to keep going.
                call.reject(e.message ?: "ssh connect failed", e)
            }
        }
    }

    private fun startPortForward(client: SSHClient, spec: String) {
        // Accept "local:remoteHost:remote" or "local:remote" or "PORT".
        val parts = spec.split(":")
        val (local, remoteHost, remote) = when (parts.size) {
            1 -> Triple(parts[0], "localhost", parts[0])
            2 -> Triple(parts[0], "localhost", parts[1])
            3 -> Triple(parts[0], parts[1], parts[2])
            else -> return
        }
        val localPort = local.toIntOrNull() ?: return
        val remotePort = remote.toIntOrNull() ?: return

        thread(name = "ssh-fwd-$local") {
            val ok = Sshj.startLocalPortForward(client, localPort, remoteHost, remotePort)
            if (!ok) {
                val ev = JSObject().apply {
                    put("error", "port forward $spec failed (sshj API not found at runtime)")
                }
                notifyListeners("warning", ev)
            }
        }
    }

    private fun emitExit(tabId: String, entry: Entry) {
        if (!entry.alive) return  // already emitted
        entry.alive = false
        val exitCode = Sshj.getExitStatus(entry.session) ?: 0
        try { entry.shell.close() } catch (_: Throwable) {}
        try { entry.session.close() } catch (_: Throwable) {}
        try { entry.client.disconnect() } catch (_: Throwable) {}
        sessions.remove(tabId)
        val ev = JSObject().apply {
            put("tabId", tabId)
            put("exitCode", exitCode)
        }
        notifyListeners("exit", ev)
        if (sessions.isEmpty()) stopForegroundService()
    }

    // ------------------------------------------------------------ write / resize / close

    @PluginMethod
    fun write(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val data = call.getString("data") ?: return call.reject("data required")
        val entry = sessions[tabId] ?: return call.reject("no session for tabId")
        try {
            val out: OutputStream = entry.shell.outputStream
            out.write(data.toByteArray(StandardCharsets.UTF_8))
            out.flush()
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
            Sshj.resizePty(entry.session, cols, rows)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "resize failed", e)
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        // Cancel an in-flight connect first — disconnect() interrupts
        // sshj's blocking socket ops so the connect thread unwinds
        // and reports a clean failure to JS.
        val pendingClient = pending.remove(tabId)
        if (pendingClient != null) {
            try { pendingClient.disconnect() } catch (_: Throwable) {}
        }
        val entry = sessions[tabId]
        if (entry != null) emitExit(tabId, entry)
        call.resolve()
    }

    // ------------------------------------------------------------ SFTP

    /**
     * Upload base64-encoded bytes to a remote path. Used by the image
     * paste flow: phone reads a gallery image, hands the bytes here,
     * we drop it on the SSH host so claude or whatever's running in
     * the shell can read it from a path.
     */
    @PluginMethod
    fun sftpPut(call: PluginCall) {
        val tabId = call.getString("tabId") ?: return call.reject("tabId required")
        val remotePath = call.getString("remotePath") ?: return call.reject("remotePath required")
        val dataBase64 = call.getString("dataBase64") ?: return call.reject("dataBase64 required")
        val entry = sessions[tabId] ?: return call.reject("no session for tabId")

        thread(name = "sftp-put-$tabId") {
            try {
                val bytes = Base64.decode(dataBase64, Base64.DEFAULT)
                // Stage as a temp file because sshj's SFTP put takes a path.
                val tmp = File.createTempFile("upload_", ".bin", context.cacheDir)
                tmp.writeBytes(bytes)
                try {
                    entry.client.newSFTPClient().use { sftp ->
                        // Ensure parent dir exists; ignore failure if it
                        // already does.
                        val parent = remotePath.substringBeforeLast('/', "")
                        if (parent.isNotEmpty()) {
                            try { sftp.mkdirs(parent) } catch (_: Throwable) {}
                        }
                        sftp.put(tmp.absolutePath, remotePath)
                    }
                    call.resolve(JSObject().apply { put("remotePath", remotePath) })
                } finally {
                    tmp.delete()
                }
            } catch (e: Exception) {
                call.reject(e.message ?: "sftp put failed", e)
            }
        }
    }

    // ------------------------------------------------------------ list

    @PluginMethod
    fun listActive(call: PluginCall) {
        val arr = com.getcapacitor.JSArray()
        for ((id, entry) in sessions) {
            if (entry.alive) arr.put(id)
        }
        call.resolve(JSObject().apply { put("tabIds", arr) })
    }

    // ------------------------------------------------------------ foreground service

    private fun ensureForegroundService() {
        val ctx = context
        val intent = Intent(ctx, ForegroundService::class.java)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
    }

    private fun stopForegroundService() {
        val ctx = context
        ctx.stopService(Intent(ctx, ForegroundService::class.java))
    }
}
