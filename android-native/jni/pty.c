/*
 * JNI wrapper around forkpty(3) for the LocalShellPlugin.
 *
 * Java doesn't expose POSIX PTYs, so we go through the NDK: forkpty(),
 * read(), write(), and TIOCSWINSZ via ioctl. The Kotlin side lives in
 * Pty.kt and just trampolines into these functions.
 *
 * Single-shot per session: forkPty() spawns the requested binary
 * (e.g. /system/bin/sh, or later proot wrapping Alpine), wires up a
 * pseudo-terminal, and returns [masterFd, pid]. Reads happen on a
 * dedicated Kotlin thread; writes are synchronous from the WebView's
 * main thread (write() to a PTY master rarely blocks).
 *
 * One subtle point: we set the slave's termios to a near-raw mode
 * but keep ICRNL+OPOST+ONLCR+ECHO so a vanilla /bin/sh on the other
 * end behaves like a normal interactive terminal — Enter == CR, line
 * editing works, output gets CRLF for xterm.js's renderer.
 */

#include <jni.h>
#include <pty.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <android/log.h>

#define TAG "ClaudePty"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static char **alloc_cstr_array(JNIEnv *env, jobjectArray arr, jint *out_count) {
    jint n = (*env)->GetArrayLength(env, arr);
    *out_count = n;
    char **out = (char **)calloc(n + 1, sizeof(char *));
    if (!out) return NULL;
    for (jint i = 0; i < n; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, arr, i);
        const char *cstr = (*env)->GetStringUTFChars(env, s, NULL);
        out[i] = strdup(cstr ? cstr : "");
        (*env)->ReleaseStringUTFChars(env, s, cstr);
        (*env)->DeleteLocalRef(env, s);
    }
    return out;
}

static void free_cstr_array(char **arr) {
    if (!arr) return;
    for (char **p = arr; *p; p++) free(*p);
    free(arr);
}

JNIEXPORT jintArray JNICALL
Java_app_claudesessions_android_Pty_forkPty(
    JNIEnv *env, jclass clazz,
    jobjectArray argv,
    jobjectArray envp,
    jstring cwd,
    jint cols, jint rows
) {
    (void)clazz;

    jint argc = 0, envc = 0;
    char **cArgv = alloc_cstr_array(env, argv, &argc);
    char **cEnvp = alloc_cstr_array(env, envp, &envc);
    char *cCwd = NULL;
    if (cwd) {
        const char *s = (*env)->GetStringUTFChars(env, cwd, NULL);
        cCwd = strdup(s ? s : "");
        (*env)->ReleaseStringUTFChars(env, cwd, s);
    }

    if (!cArgv || !cEnvp || argc < 1 || !cArgv[0]) {
        LOGE("forkPty: invalid argv/envp");
        free_cstr_array(cArgv);
        free_cstr_array(cEnvp);
        free(cCwd);
        jintArray ret = (*env)->NewIntArray(env, 2);
        jint vals[2] = {-1, -1};
        (*env)->SetIntArrayRegion(env, ret, 0, 2, vals);
        return ret;
    }

    int master = -1;
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);

    struct termios tio;
    memset(&tio, 0, sizeof(tio));
    cfmakeraw(&tio);
    // Re-enable line discipline bits that interactive xterm-aware
    // shells expect (and that xterm.js itself emits CRLF for):
    tio.c_iflag |= ICRNL | IUTF8;
    tio.c_oflag |= OPOST | ONLCR;
    tio.c_lflag |= ICANON | ISIG | ECHO | ECHOE | ECHOK | ECHOCTL;
    tio.c_cc[VINTR]  = 0x03;  // ^C
    tio.c_cc[VQUIT]  = 0x1C;  // ^\
    tio.c_cc[VERASE] = 0x7F;  // DEL
    tio.c_cc[VKILL]  = 0x15;  // ^U
    tio.c_cc[VEOF]   = 0x04;  // ^D
    cfsetispeed(&tio, B38400);
    cfsetospeed(&tio, B38400);

    pid_t pid = forkpty(&master, NULL, &tio, &ws);
    if (pid < 0) {
        LOGE("forkpty failed: %s", strerror(errno));
        free_cstr_array(cArgv);
        free_cstr_array(cEnvp);
        free(cCwd);
        jintArray ret = (*env)->NewIntArray(env, 2);
        jint vals[2] = {-1, -1};
        (*env)->SetIntArrayRegion(env, ret, 0, 2, vals);
        return ret;
    }

    if (pid == 0) {
        // ---- Child ----
        // Become process-group / session leader so we get our own
        // controlling terminal (the slave PTY) — forkpty did this for
        // us via login_tty(), but setsid is idempotent.
        setsid();
        // Reset signal handlers we may have inherited from the JVM.
        signal(SIGCHLD, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        signal(SIGTTOU, SIG_DFL);
        signal(SIGTTIN, SIG_DFL);

        if (cCwd && *cCwd) {
            // Best-effort: if chdir fails just continue; the shell
            // will start in whatever cwd the parent had.
            (void)chdir(cCwd);
        }

        execve(cArgv[0], cArgv, cEnvp);
        // exec failed — write something visible then exit so the
        // parent reader thread sees data + an EOF.
        char msg[256];
        snprintf(msg, sizeof(msg), "[pty] exec %s failed: %s\r\n",
                 cArgv[0], strerror(errno));
        ssize_t r = write(STDERR_FILENO, msg, strlen(msg));
        (void)r;
        _exit(127);
    }

    // ---- Parent ----
    free_cstr_array(cArgv);
    free_cstr_array(cEnvp);
    free(cCwd);

    LOGI("forkpty ok: pid=%d masterFd=%d cols=%d rows=%d", pid, master, cols, rows);
    jintArray ret = (*env)->NewIntArray(env, 2);
    jint vals[2] = {master, (jint)pid};
    (*env)->SetIntArrayRegion(env, ret, 0, 2, vals);
    return ret;
}

JNIEXPORT jint JNICALL
Java_app_claudesessions_android_Pty_readPty(
    JNIEnv *env, jclass clazz,
    jint fd, jbyteArray buf, jint len
) {
    (void)clazz;
    if (fd < 0 || len <= 0) return -1;
    jbyte *cbuf = (*env)->GetByteArrayElements(env, buf, NULL);
    if (!cbuf) return -1;
    ssize_t n;
    do { n = read(fd, cbuf, (size_t)len); } while (n < 0 && errno == EINTR);
    (*env)->ReleaseByteArrayElements(env, buf, cbuf, 0);
    if (n < 0) return -errno;
    return (jint)n;
}

JNIEXPORT jint JNICALL
Java_app_claudesessions_android_Pty_writePty(
    JNIEnv *env, jclass clazz,
    jint fd, jbyteArray buf, jint off, jint len
) {
    (void)clazz;
    if (fd < 0 || len <= 0) return 0;
    jbyte *cbuf = (*env)->GetByteArrayElements(env, buf, NULL);
    if (!cbuf) return -1;
    ssize_t total = 0;
    while (total < len) {
        ssize_t n = write(fd, cbuf + off + total, (size_t)(len - total));
        if (n < 0) {
            if (errno == EINTR) continue;
            (*env)->ReleaseByteArrayElements(env, buf, cbuf, JNI_ABORT);
            return -errno;
        }
        total += n;
    }
    (*env)->ReleaseByteArrayElements(env, buf, cbuf, JNI_ABORT);
    return (jint)total;
}

JNIEXPORT jint JNICALL
Java_app_claudesessions_android_Pty_resizePty(
    JNIEnv *env, jclass clazz,
    jint fd, jint cols, jint rows
) {
    (void)env; (void)clazz;
    if (fd < 0) return -1;
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
    return ioctl(fd, TIOCSWINSZ, &ws) < 0 ? -errno : 0;
}

JNIEXPORT jint JNICALL
Java_app_claudesessions_android_Pty_waitForExit(
    JNIEnv *env, jclass clazz,
    jint pid
) {
    (void)env; (void)clazz;
    if (pid <= 0) return -1;
    int status = 0;
    pid_t r;
    do { r = waitpid((pid_t)pid, &status, 0); } while (r < 0 && errno == EINTR);
    if (r < 0) return -1;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -1;
}

JNIEXPORT void JNICALL
Java_app_claudesessions_android_Pty_closeFd(
    JNIEnv *env, jclass clazz,
    jint fd
) {
    (void)env; (void)clazz;
    if (fd >= 0) close(fd);
}

JNIEXPORT void JNICALL
Java_app_claudesessions_android_Pty_killPid(
    JNIEnv *env, jclass clazz,
    jint pid, jint sig
) {
    (void)env; (void)clazz;
    if (pid > 0) kill((pid_t)pid, sig);
}
