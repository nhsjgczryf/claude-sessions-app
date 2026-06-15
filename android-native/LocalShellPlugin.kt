/*
 * Capacitor plugin that spawns a local PTY in the app's own process,
 * either as a raw Android /system/bin/sh (Phase 1 fallback) or — when
 * the bundled Linux assets are present — as a PRoot-wrapped Alpine
 * Linux shell with bash, tmux, nodejs, and claude-code preinstalled.
 *
 * First connect of any tab type triggers a one-time bootstrap:
 *
 *   1. Copy assets/proot-arm64        → filesDir/proot-arm64  (chmod +x)
 *   2. Stream assets/alpine-rootfs.tar.zst through Zstd + Tar into
 *      filesDir/linux/                 (~15-30s on a midrange phone)
 *   3. Write filesDir/linux-ready.<version> as the readiness marker so
 *      subsequent launches skip extraction.
 *
 * Progress is reported back to JS via `status` events keyed by tabId so
 * the user sees "Extracting Linux environment (45%)…" instead of
 * staring at a blank terminal.
 *
 * If any extraction step fails — corrupt tar, out of disk, missing
 * asset — we fall back to /system/bin/sh and emit a status line
 * explaining what happened. That gives the user *some* shell instead
 * of a blocked tab.
 */
package app.claudesessions.android

import android.content.res.AssetManager
import android.os.StatFs
import android.system.Os
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.github.luben.zstd.ZstdInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
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

    // Serialize the bootstrap. Two tabs connecting at first launch
    // both call ensureLinuxBootstrapped(); we want the second to wait
    // (via the synchronized block) rather than racing to write to
    // filesDir/linux/ in parallel.
    private val bootstrapLock = Object()
    private val bootstrapInProgress = AtomicBoolean(false)

    // -----------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------

    private val PROOT_ASSET = "proot-arm64"
    private val ROOTFS_ASSET = "alpine-rootfs.tar.zst"
    private val VERSION_ASSET = "rootfs-version.txt"

    // Minimum free bytes we want available before starting extraction.
    // Conservative: rootfs uncompressed is ~150-200 MB; leave headroom.
    private val MIN_FREE_BYTES = 350L * 1024 * 1024

    // -----------------------------------------------------------------
    // emitStatus / connect / write / resize / close
    // -----------------------------------------------------------------

    private fun emitStatus(tabId: String, status: String) {
        val ev = JSObject().apply {
            put("tabId", tabId)
            put("status", status)
        }
        notifyListeners("status", ev)
    }

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

        // Connect (extraction + fork) runs on a worker. Resolves the
        // PluginCall as soon as we have a PID + masterFd; the reader
        // thread continues streaming data/exit events afterwards.
        thread(name = "local-connect-$tabId") {
            try {
                val argv = prepareArgv(tabId)
                val env = prepareEnv()
                val cwd = if (linuxRootfsReady()) "/root" else context.filesDir.absolutePath

                emitStatus(tabId, "Starting shell…")
                val result = Pty.forkPty(argv, env, cwd, cols, rows)
                if (result.size != 2 || result[0] < 0 || result[1] < 0) {
                    call.reject("forkPty failed (returned ${result.contentToString()})")
                    return@thread
                }

                val entry = Entry(tabId, pid = result[1], masterFd = result[0])
                sessions[tabId] = entry
                // Keep the process + wake lock alive in the background
                // so the shell (and anything running in it — tmux,
                // node, etc.) survives the user switching apps.
                try { KeepAlive.acquire(context) } catch (_: Throwable) {}
                startReader(entry)

                if (!initialCommand.isNullOrBlank()) {
                    try {
                        val data = (initialCommand + "\r").toByteArray(StandardCharsets.UTF_8)
                        Pty.writePty(entry.masterFd, data, 0, data.size)
                    } catch (_: Throwable) {}
                }

                call.resolve(JSObject().apply { put("tabId", tabId) })
            } catch (e: UnsatisfiedLinkError) {
                call.reject("native PTY library missing: ${e.message}")
            } catch (e: Exception) {
                call.reject("local shell launch failed: ${e.message}", e)
            }
        }
    }

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
        // Reader thread closes the FD once it observes EOF — racing
        // it here would leak a double-close.
        call.resolve()
    }

    /**
     * Read a file from inside the bundled Alpine rootfs for read-only
     * preview. A guest-absolute path like /root/foo.md maps to the host
     * path filesDir/linux/root/foo.md (proot is just a chroot over that
     * directory); a relative path resolves against /root. We canonicalize
     * and verify the result stays under linuxDir so a crafted ../ path
     * can't escape the rootfs and read arbitrary app/system files.
     * Reads at most maxBytes; returns { base64, size, truncated }.
     */
    @PluginMethod
    fun readFile(call: PluginCall) {
        val pathArg = call.getString("path") ?: return call.reject("path required")
        val maxBytes = (call.getInt("maxBytes") ?: (1024 * 1024)).coerceAtLeast(1)
        thread(name = "local-readfile") {
            try {
                val root = linuxDir().canonicalFile
                val rel = pathArg.removePrefix("/").ifEmpty { "root" }
                val guestAbs = if (pathArg.startsWith("/")) rel else "root/$rel"
                val target = File(root, guestAbs).canonicalFile
                if (target != root && !target.path.startsWith(root.path + File.separator)) {
                    call.reject("path escapes the Linux rootfs")
                    return@thread
                }
                if (!target.isFile) { call.reject("not a file: $pathArg"); return@thread }
                val size = target.length()
                val toRead = minOf(size, maxBytes.toLong()).toInt()
                val buf = ByteArray(toRead)
                target.inputStream().use { ins ->
                    var read = 0
                    while (read < toRead) {
                        val n = ins.read(buf, read, toRead - read)
                        if (n <= 0) break
                        read += n
                    }
                    val out = if (read == buf.size) buf else buf.copyOf(read)
                    call.resolve(JSObject().apply {
                        put("base64", android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP))
                        put("size", size)
                        put("truncated", size > maxBytes.toLong())
                    })
                }
            } catch (e: Exception) {
                call.reject(e.message ?: "read failed", e)
            }
        }
    }

    /**
     * JS notifies us when a local-shell tab becomes the active focus
     * (or stops being so). When active, we register a sender closure
     * with InputRouter so the WebView's native InputConnection wrapper
     * can stream IME-composed text straight into this tab's PTY,
     * bypassing the broken xterm.js textarea route. Passing tabId=null
     * tears down the registration (typically: editor modal opened,
     * other plugin's tab became active, or no tab selected).
     */
    @PluginMethod
    fun setActiveTab(call: PluginCall) {
        val tabId = call.getString("tabId")
        if (tabId == null) {
            InputRouter.clearIfOwnedBy("local")
            call.resolve()
            return
        }
        val entry = sessions[tabId] ?: return call.reject("no such tab: $tabId")
        InputRouter.set("local") { text ->
            try {
                val bytes = text.toByteArray(StandardCharsets.UTF_8)
                Pty.writePty(entry.masterFd, bytes, 0, bytes.size)
            } catch (e: Exception) {
                android.util.Log.w("LocalShellPlugin",
                    "active-tab write to ${entry.tabId} failed: ${e.message}")
            }
        }
        call.resolve()
    }

    // -----------------------------------------------------------------
    // Reader thread — drains the PTY, emits data/exit events
    // -----------------------------------------------------------------

    private fun startReader(entry: Entry) {
        thread(name = "local-pty-${entry.tabId}") {
            val buf = ByteArray(8192)
            try {
                while (entry.alive) {
                    val n = Pty.readPty(entry.masterFd, buf, buf.size)
                    if (n <= 0) break
                    val data = String(buf, 0, n, StandardCharsets.UTF_8)
                    val ev = JSObject().apply {
                        put("tabId", entry.tabId)
                        put("data", data)
                    }
                    notifyListeners("data", ev)
                }
            } catch (_: Throwable) {
                // Connection died — fall through to exit reporting.
            }
            val exitCode = try { Pty.waitForExit(entry.pid) } catch (_: Throwable) { -1 }
            entry.alive = false
            sessions.remove(entry.tabId)
            try { Pty.closeFd(entry.masterFd) } catch (_: Throwable) {}
            try { KeepAlive.release(context) } catch (_: Throwable) {}
            InputRouter.clearIfOwnedBy("local")
            val ev = JSObject().apply {
                put("tabId", entry.tabId)
                put("exitCode", exitCode)
            }
            notifyListeners("exit", ev)
        }
    }

    // -----------------------------------------------------------------
    // argv / env selection: bundled Alpine if available, else fallback
    // -----------------------------------------------------------------

    private fun prepareArgv(tabId: String): Array<String> {
        return if (hasBundledRootfs()) {
            ensureLinuxBootstrapped(tabId)
            if (linuxRootfsReady()) {
                bundledArgv()
            } else {
                emitStatus(tabId, "Falling back to /system/bin/sh (extraction failed)")
                fallbackArgv()
            }
        } else {
            // No bundle in the APK (e.g., dev build, or CI's rootfs
            // step was skipped). Quietly use the system shell.
            fallbackArgv()
        }
    }

    private fun bundledArgv(): Array<String> {
        val proot = File(context.filesDir, PROOT_ASSET).absolutePath
        val rootfs = linuxDir().absolutePath
        // -0           — fake uid 0 inside the guest. Almost everything
        //                Alpine ships expects root-ish behavior.
        // -w /root     — start in /root with the .profile we baked in.
        // -b /dev etc. — expose host kernel interfaces the guest needs.
        // -b /sdcard   — let the user reach their phone's shared
        //                storage when present. Skipped on devices that
        //                don't expose it to avoid a noisy proot warning.
        val args = mutableListOf(
            proot,
            "-r", rootfs,
            "-w", "/root",
            "-0",
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
        )
        if (File("/sdcard").exists()) {
            args.add("-b"); args.add("/sdcard")
        }
        args.addAll(listOf("/bin/sh", "-l"))
        return args.toTypedArray()
    }

    private fun fallbackArgv(): Array<String> = arrayOf("/system/bin/sh")

    private fun prepareEnv(): Array<String> {
        val filesDir = context.filesDir.absolutePath
        val cacheDir = context.cacheDir.absolutePath
        return arrayOf(
            // PATH inside the guest is set by /etc/profile + .profile;
            // the host-side PATH here only matters until proot hands
            // off to /bin/sh -l.
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/system/bin:/system/xbin",
            "TERM=xterm-256color",
            "HOME=$filesDir",
            "TMPDIR=$cacheDir",
            "LC_ALL=C.UTF-8",
            "LANG=C.UTF-8",
            // Tell proot where to put its own internal sockets etc.
            "PROOT_TMP_DIR=$cacheDir",
        )
    }

    // -----------------------------------------------------------------
    // Bundle detection + bootstrap
    // -----------------------------------------------------------------

    private fun hasBundledRootfs(): Boolean {
        return try {
            context.assets.list("")?.let { entries ->
                entries.contains(ROOTFS_ASSET) && entries.contains(PROOT_ASSET)
            } ?: false
        } catch (_: Exception) { false }
    }

    private fun linuxDir(): File = File(context.filesDir, "linux")

    private fun markerFile(): File {
        val version = bundledVersion()
        return File(context.filesDir, "linux-ready.$version")
    }

    private fun linuxRootfsReady(): Boolean {
        if (!hasBundledRootfs()) return false
        return markerFile().exists() && linuxDir().isDirectory &&
            File(context.filesDir, PROOT_ASSET).canExecute()
    }

    private fun bundledVersion(): String {
        return try {
            context.assets.open(VERSION_ASSET).use { it.bufferedReader().readText().trim() }
        } catch (_: Exception) { "unknown" }
    }

    private fun ensureLinuxBootstrapped(tabId: String) {
        if (linuxRootfsReady()) return
        if (bootstrapInProgress.get()) {
            emitStatus(tabId, "Waiting for another tab to finish first-launch setup…")
        }
        // synchronized() blocks the second caller until the first
        // returns; after that, linuxRootfsReady() short-circuits.
        synchronized(bootstrapLock) {
            if (linuxRootfsReady()) return
            bootstrapInProgress.set(true)
            try {
                runBootstrap(tabId)
            } catch (e: Exception) {
                emitStatus(tabId, "Bootstrap failed: ${e.message}")
                // Best-effort cleanup so the next attempt isn't poisoned
                // by partial state.
                try { linuxDir().deleteRecursively() } catch (_: Exception) {}
                try { markerFile().delete() } catch (_: Exception) {}
            } finally {
                bootstrapInProgress.set(false)
            }
        }
    }

    private fun runBootstrap(tabId: String) {
        emitStatus(tabId, "Setting up Linux environment (first launch, ~30s)…")

        // Disk-space sanity check up front. Better to fail loudly than
        // to mid-extract a half-rootfs and confuse the user.
        val stat = StatFs(context.filesDir.absolutePath)
        val free = stat.availableBytes
        if (free < MIN_FREE_BYTES) {
            throw IllegalStateException(
                "need ${MIN_FREE_BYTES / (1024 * 1024)} MB free, only " +
                    "${free / (1024 * 1024)} MB available"
            )
        }

        // 1. Copy proot binary out of the APK. AssetManager.open() returns
        //    a synthetic stream; we drop it onto disk and chmod 0o755.
        emitStatus(tabId, "Extracting PRoot binary…")
        val prootFile = File(context.filesDir, PROOT_ASSET)
        if (!prootFile.exists() || !prootFile.canExecute()) {
            context.assets.open(PROOT_ASSET).use { input ->
                FileOutputStream(prootFile).use { output -> input.copyTo(output) }
            }
            try {
                Os.chmod(prootFile.absolutePath, 0b111_101_101)  // 0o755
            } catch (e: Exception) {
                if (!prootFile.setExecutable(true, /*ownerOnly=*/false)) {
                    throw IllegalStateException("chmod +x failed on proot binary: ${e.message}")
                }
            }
        }

        // 2. Stream the rootfs tar.zst into linuxDir/.
        emitStatus(tabId, "Extracting Alpine rootfs (this is the slow part)…")
        val target = linuxDir()
        // Clean target if any stale partial extraction is lying around.
        if (target.exists()) {
            target.deleteRecursively()
        }
        target.mkdirs()
        extractRootfs(target, tabId)

        // 3. Write readiness marker once the dust settles.
        markerFile().writeText(System.currentTimeMillis().toString())
        emitStatus(tabId, "Linux environment ready.")
    }

    /**
     * Streams `assets/alpine-rootfs.tar.zst` through zstd → tar →
     * filesystem. Reports a percentage in status events at ~1-second
     * intervals so the JS terminal shows live progress instead of
     * appearing frozen for 20 seconds.
     */
    private fun extractRootfs(target: File, tabId: String) {
        // openFd succeeds only if AAPT kept the asset uncompressed,
        // which the `noCompress 'zst'` patch in android-init.js ensures.
        // If that ever regresses, fall back to "unknown total" rather
        // than failing the whole extraction.
        val totalCompressed: Long = try {
            context.assets.openFd(ROOTFS_ASSET).use { it.length }
        } catch (_: Exception) { -1L }

        val absRoot = target.canonicalPath
        var lastReportMs = 0L
        var entryCount = 0

        // CountingInputStream so we know how far through the .zst we are.
        // Apache commons-compress also has this but we want a small
        // dependency footprint — Java's FilterInputStream is fine.
        val rawIn = BufferedInputStream(
            context.assets.open(ROOTFS_ASSET, AssetManager.ACCESS_STREAMING)
        )
        val counter = CountingInputStream(rawIn)
        val zstdIn = ZstdInputStream(counter)
        val tarIn = TarArchiveInputStream(zstdIn)

        tarIn.use { tar ->
            var entry: TarArchiveEntry? = tar.nextEntry
            while (entry != null) {
                val outPath = File(target, entry.name)
                // Defensive: tar can carry "../" paths. Refuse anything
                // that would escape target/.
                val canon = outPath.canonicalPath
                if (!canon.startsWith(absRoot)) {
                    throw IllegalStateException("rootfs tar contains escape path: ${entry.name}")
                }

                when {
                    entry.isDirectory -> outPath.mkdirs()
                    entry.isSymbolicLink -> {
                        // proot rebases /, so absolute symlinks INSIDE
                        // the rootfs (e.g. /sbin -> /bin/busybox) work
                        // out. We just create them verbatim.
                        outPath.parentFile?.mkdirs()
                        try {
                            if (outPath.exists()) outPath.delete()
                            Os.symlink(entry.linkName, outPath.absolutePath)
                        } catch (_: Exception) {
                            // Symlinks are best-effort; some scenarios
                            // (existing dir, restricted FS) leave us
                            // without one and that's still usually OK.
                        }
                    }
                    entry.isFile -> {
                        outPath.parentFile?.mkdirs()
                        FileOutputStream(outPath).use { out -> tar.copyTo(out) }
                        // Preserve the full mode where possible —
                        // important for /bin/sh, /bin/busybox,
                        // /usr/bin/node, etc.
                        val mode = entry.mode and 0xFFF
                        try {
                            Os.chmod(outPath.absolutePath, mode)
                        } catch (_: Exception) {
                            if (mode and 0b001_001_001 != 0) {  // any exec bit
                                outPath.setExecutable(true, /*ownerOnly=*/false)
                            }
                        }
                    }
                    // Skip char/block devices, fifos — proot would
                    // refuse them anyway.
                }
                entryCount++

                val now = System.currentTimeMillis()
                if (now - lastReportMs > 1000) {
                    lastReportMs = now
                    if (totalCompressed > 0) {
                        val pct = (counter.bytesRead * 100 / totalCompressed)
                            .coerceIn(0, 99)
                        emitStatus(tabId, "Extracting Alpine rootfs… ${pct}% ($entryCount files)")
                    } else {
                        emitStatus(tabId, "Extracting Alpine rootfs… ($entryCount files)")
                    }
                }
                entry = tar.nextEntry
            }
        }
        emitStatus(tabId, "Extracted $entryCount entries from rootfs.")
    }

    /**
     * Trivial counter so we can report extraction progress without
     * pulling commons-io for CountingInputStream.
     */
    private class CountingInputStream(private val inner: InputStream) : InputStream() {
        @Volatile var bytesRead: Long = 0L
            private set

        override fun read(): Int {
            val b = inner.read()
            if (b >= 0) bytesRead++
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = inner.read(b, off, len)
            if (n > 0) bytesRead += n
            return n
        }

        override fun close() { inner.close() }
    }
}
