/*
 * Reflective shims around sshj API surface that has shifted between
 * versions. Lets us compile against a wider range of sshj versions
 * without binding to specific class paths that the upstream library
 * has moved around (PTYMode jumped between subpackages, the resize
 * method was renamed from changeWindowDimensions to
 * requestWindowChange at some point, LocalPortForwarder.Parameters
 * moved with its parent, etc.).
 *
 * All methods are best-effort: they swallow exceptions and return
 * either a success boolean or a nullable result. Failures get logged
 * (via stderr) but don't crash the plugin — the caller decides how to
 * surface the issue.
 */
package app.claudesessions.android

import java.io.ByteArrayInputStream
import java.lang.reflect.Method

internal object Sshj {

    // ---- PTY allocation ---------------------------------------------------

    /**
     * Call session.allocatePTY(type, cols, rows, 0, 0, emptyMap()).
     * Falls back to session.allocateDefaultPTY() if the 6-arg variant
     * isn't available.
     */
    fun allocatePty(session: Any, type: String, cols: Int, rows: Int): Boolean {
        try {
            val m6 = findMethod(session, "allocatePTY", 6)
            if (m6 != null) {
                // The last parameter is Map<PTYMode, Integer> at compile
                // time but at runtime the JVM erases it to raw Map, so
                // we can hand it a HashMap<Object, Object>. An empty
                // map is what we want anyway (no modes).
                m6.invoke(session, type, cols, rows, 0, 0, java.util.HashMap<Any, Any>())
                return true
            }
            val mDefault = findMethod(session, "allocateDefaultPTY", 0)
            if (mDefault != null) {
                mDefault.invoke(session)
                return true
            }
        } catch (t: Throwable) {
            System.err.println("[Sshj] allocatePty: ${t.message}")
        }
        return false
    }

    // ---- PTY resize -------------------------------------------------------

    /**
     * Send a window-change request. sshj 0.30 named the method
     * changeWindowDimensions; later versions renamed it to
     * requestWindowChange. We try both.
     */
    fun resizePty(session: Any, cols: Int, rows: Int): Boolean {
        for (name in arrayOf("changeWindowDimensions", "requestWindowChange")) {
            val m = findMethod(session, name, 4)
            if (m != null) {
                try {
                    m.invoke(session, cols, rows, 0, 0)
                    return true
                } catch (_: Throwable) {}
            }
        }
        return false
    }

    // ---- Exit status ------------------------------------------------------

    fun getExitStatus(session: Any): Int? {
        return try {
            val m = session.javaClass.methods.firstOrNull {
                it.name == "getExitStatus" && it.parameterCount == 0
            } ?: return null
            (m.invoke(session) as? Number)?.toInt()
        } catch (_: Throwable) { null }
    }

    // ---- Local port forward ----------------------------------------------

    /**
     * Start an `ssh -L localPort:remoteHost:remotePort` forward.
     * Returns true if the forwarder was created and its listen()
     * method was invoked (blocks until torn down, run on caller's
     * thread). Returns false if the API couldn't be located.
     */
    fun startLocalPortForward(
        client: Any,
        localPort: Int,
        remoteHost: String,
        remotePort: Int,
    ): Boolean {
        // sshj's Parameters class moved between subpackages across
        // versions. Try all the known locations.
        val paramsCls = arrayOf(
            "net.schmizz.sshj.connection.channel.direct.LocalPortForwarder\$Parameters",
            "net.schmizz.sshj.connection.channel.forwarded.LocalPortForwarder\$Parameters",
        ).firstNotNullOfOrNull { name ->
            try { Class.forName(name) } catch (_: Throwable) { null }
        } ?: return false

        return try {
            val ctor = paramsCls.getConstructor(
                String::class.java, Int::class.javaPrimitiveType,
                String::class.java, Int::class.javaPrimitiveType,
            )
            val params = ctor.newInstance("127.0.0.1", localPort, remoteHost, remotePort)

            val ss = java.net.ServerSocket()
            ss.reuseAddress = true
            ss.bind(java.net.InetSocketAddress("127.0.0.1", localPort))

            val newFwd = client.javaClass.methods.firstOrNull {
                it.name == "newLocalPortForwarder" && it.parameterCount == 2
            } ?: return false
            val forwarder = newFwd.invoke(client, params, ss) ?: return false

            val listen = forwarder.javaClass.getMethod("listen")
            listen.invoke(forwarder)  // blocks
            true
        } catch (t: Throwable) {
            System.err.println("[Sshj] startLocalPortForward failed: ${t.message}")
            false
        }
    }

    // ---- internal --------------------------------------------------------

    private fun findMethod(target: Any, name: String, arity: Int): Method? {
        return try {
            target.javaClass.methods.firstOrNull {
                it.name == name && it.parameterCount == arity
            }
        } catch (_: Throwable) { null }
    }
}
