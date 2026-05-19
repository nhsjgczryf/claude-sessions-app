/*
 * Kotlin trampoline for the JNI PTY functions in jni/pty.c.
 *
 * Static-init loads libclaudesessions_pty.so once on first access.
 * If that fails (unsupported ABI, .so missing from APK, etc.) every
 * call into this object will throw UnsatisfiedLinkError; callers
 * (LocalShellPlugin) catch that and surface a useful message to JS.
 */
package app.claudesessions.android

internal object Pty {

    private var libraryLoaded: Boolean = false
    var loadError: String? = null
        private set

    init {
        try {
            System.loadLibrary("claudesessions_pty")
            libraryLoaded = true
        } catch (t: Throwable) {
            loadError = "${t.javaClass.simpleName}: ${t.message}"
        }
    }

    fun isAvailable(): Boolean = libraryLoaded

    /**
     * Fork a child, wire it to a PTY, and exec the argv[0] binary.
     * Returns [masterFd, pid]. Both are -1 if any step failed.
     */
    @JvmStatic external fun forkPty(
        argv: Array<String>,
        env: Array<String>,
        cwd: String?,
        cols: Int,
        rows: Int,
    ): IntArray

    /** Read up to len bytes from the master FD into buf. Returns
     *  bytes read, 0 on EOF, or negative errno. */
    @JvmStatic external fun readPty(fd: Int, buf: ByteArray, len: Int): Int

    /** Write buf[off..off+len) to the master FD. Loops on partial
     *  writes; returns total bytes written or negative errno. */
    @JvmStatic external fun writePty(fd: Int, buf: ByteArray, off: Int, len: Int): Int

    /** TIOCSWINSZ on the master FD. Returns 0 on success or -errno. */
    @JvmStatic external fun resizePty(fd: Int, cols: Int, rows: Int): Int

    /** Blocking waitpid on the child. Returns Unix exit code, or
     *  128+signal if killed, or -1 if waitpid failed. */
    @JvmStatic external fun waitForExit(pid: Int): Int

    /** close(fd). No-op on negative fd. */
    @JvmStatic external fun closeFd(fd: Int)

    /** kill(pid, sig). No-op on non-positive pid. */
    @JvmStatic external fun killPid(pid: Int, sig: Int)
}
