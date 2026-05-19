/*
 * Minimal foreground service whose only job is to display a persistent
 * notification so Android keeps our process around — and with it, the
 * SSH connections held by SshPlugin — when the WebView is backgrounded
 * or the user switches apps. Without this, Android 12+ aggressively
 * kills idle WebView-only apps within seconds to a few minutes.
 */
package app.claudesessions.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class ForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = launchIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Claude Sessions")
            .setContentText("Keeping SSH sessions alive")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        startForeground(NOTIF_ID, n)
        // START_STICKY: if Android kills us under heavy pressure,
        // come back when memory frees up so we re-bind to the WebView
        // process if it's still around.
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            "Active SSH sessions",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the app alive while terminals are connected."
            setShowBadge(false)
        }
        mgr.createNotificationChannel(ch)
    }

    companion object {
        private const val CHANNEL_ID = "claude-sessions-active"
        private const val NOTIF_ID = 1
    }
}
