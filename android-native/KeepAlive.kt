/*
 * Reference-counted foreground-service controller shared by both
 * SshPlugin and LocalShellPlugin. Each live terminal session (SSH or
 * local PTY) holds one reference; the ForegroundService — and the
 * partial wake lock it owns — stays up as long as the count is > 0.
 *
 * Centralizing it here means a phone with one SSH tab and one local
 * tab keeps a single service alive, and closing either one doesn't
 * prematurely tear down keep-alive for the other.
 */
package app.claudesessions.android

import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.concurrent.atomic.AtomicInteger

object KeepAlive {

    private val refs = AtomicInteger(0)

    /** Call when a session becomes live. Starts the foreground
     *  service on the 0 → 1 transition. */
    fun acquire(ctx: Context) {
        val n = refs.incrementAndGet()
        if (n == 1) startService(ctx.applicationContext)
    }

    /** Call when a session ends. Stops the service on the 1 → 0
     *  transition. Idempotent / clamped so a double-release can't
     *  drive the count negative. */
    fun release(ctx: Context) {
        val n = refs.updateAndGet { if (it > 0) it - 1 else 0 }
        if (n == 0) stopService(ctx.applicationContext)
    }

    private fun startService(ctx: Context) {
        try {
            val intent = Intent(ctx, ForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        } catch (t: Throwable) {
            android.util.Log.e("ClaudeFGS", "startService failed: ${t.message}", t)
        }
    }

    private fun stopService(ctx: Context) {
        try {
            ctx.stopService(Intent(ctx, ForegroundService::class.java))
        } catch (t: Throwable) {
            android.util.Log.e("ClaudeFGS", "stopService failed: ${t.message}", t)
        }
    }
}
