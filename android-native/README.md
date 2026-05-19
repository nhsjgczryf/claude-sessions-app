# android-native/

Kotlin sources that get copied into `android/app/src/main/java/app/claudesessions/android/`
by `scripts/android-init.js` after `npx cap add android` generates the
Android project. Lives outside the gitignored `android/` directory so
the source-of-truth is committed.

- `SshPlugin.kt` — `SSH` Capacitor plugin: wraps [sshj](https://github.com/hierynomus/sshj)
  to expose `connect / write / resize / close / sftpPut / listActive`
  to the WebView. Each connection runs in its own thread; bytes are
  funneled back as `data` events.
- `ForegroundService.kt` — minimal foreground service that posts a
  permanent low-priority notification so Android keeps the process
  (and its SSH connections) alive when the WebView is backgrounded.

When you add a new plugin method or service, edit it here and run
`npm run android:init` — the init script will re-sync the files into
the build tree.

## Manifest / Gradle wiring

`scripts/android-init.js` also patches:

- `android/app/build.gradle` — adds the sshj dependency and the
  androidx.core compat lib that ForegroundService uses.
- `android/app/src/main/AndroidManifest.xml` — declares
  `<service ...ForegroundService/>` and adds
  `FOREGROUND_SERVICE` + `POST_NOTIFICATIONS` permissions.

## Future work

- Persist `~/.ssh/known_hosts` to `context.filesDir` and verify against
  it instead of `PromiscuousVerifier()`.
- Encrypt stored credentials with the Android Keystore instead of
  raw Capacitor Preferences.
- ProxyJump (sshj supports chained sessions but the plugin API doesn't
  expose it yet).
