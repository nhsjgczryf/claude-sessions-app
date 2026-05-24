#!/usr/bin/env node
/*
 * One-shot scaffolding for the Capacitor Android project. Idempotent —
 * safe to run repeatedly; everything is "ensure" rather than "create
 * if missing then fail otherwise".
 *
 * Responsibilities:
 *   1. Vendor xterm.js + addons from node_modules into
 *      web-android/vendor/xterm/ so the bundled WebView can load them
 *      offline (no CDN, no `import` resolver).
 *   2. Run `cap add android` (if android/ is missing) and `cap sync`.
 *   3. Copy our native plugin sources (android-native/*.kt) into the
 *      generated android/app/src/main/java/app/claudesessions/android/
 *      so Capacitor's auto-discovery picks up @CapacitorPlugin.
 *   4. Patch android/app/build.gradle to add the sshj dependency
 *      (and androidx.core for ForegroundService's NotificationCompat).
 *   5. Patch android/app/src/main/AndroidManifest.xml to declare the
 *      ForegroundService and the permissions it needs.
 *   6. Patch the gradle versionName/versionCode so each CI build is
 *      monotonically higher.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const WEB_ANDROID = path.join(ROOT, 'web-android');
const NATIVE = path.join(ROOT, 'android-native');

const APP_PACKAGE = 'app.claudesessions.android';
const APP_PACKAGE_DIR = APP_PACKAGE.replace(/\./g, '/');

function run(cmd, opts = {}) {
  console.log('[android-init] $', cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function copyIfChanged(src, dst) {
  const srcBuf = fs.readFileSync(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && fs.readFileSync(dst).equals(srcBuf)) return false;
  fs.writeFileSync(dst, srcBuf);
  console.log(`[android-init] ${path.relative(ROOT, dst)}`);
  return true;
}

// ---------------------------------------------------------------------
// 1. Vendor xterm.js for the WebView bundle
// ---------------------------------------------------------------------

function vendorXterm() {
  const vendor = path.join(WEB_ANDROID, 'vendor', 'xterm');
  const cssDir = path.join(vendor, 'css');
  const libDir = path.join(vendor, 'lib');
  fs.mkdirSync(cssDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

  const mappings = [
    ['@xterm/xterm/css/xterm.css',                          path.join(cssDir, 'xterm.css')],
    ['@xterm/xterm/lib/xterm.js',                            path.join(libDir, 'xterm.js')],
    ['@xterm/addon-fit/lib/addon-fit.js',                    path.join(libDir, 'addon-fit.js')],
    ['@xterm/addon-web-links/lib/addon-web-links.js',        path.join(libDir, 'addon-web-links.js')],
    ['@xterm/addon-unicode11/lib/addon-unicode11.js',        path.join(libDir, 'addon-unicode11.js')],
  ];
  for (const [from, to] of mappings) {
    const abs = path.join(ROOT, 'node_modules', from);
    if (!fs.existsSync(abs)) {
      throw new Error(`vendoring failed: ${from} not in node_modules — run npm install first`);
    }
    copyIfChanged(abs, to);
  }
}

// ---------------------------------------------------------------------
// 2. Capacitor scaffold
// ---------------------------------------------------------------------

function ensureCapacitorProject() {
  if (!fs.existsSync(ANDROID)) {
    run('npx --yes cap add android');
  } else {
    console.log('[android-init] android/ already exists; skipping cap add');
  }
  run('npx --yes cap sync android');
}

// ---------------------------------------------------------------------
// 3. Copy Kotlin plugin sources
// ---------------------------------------------------------------------

function copyNativeSources() {
  const dst = path.join(ANDROID, 'app', 'src', 'main', 'java', APP_PACKAGE_DIR);
  fs.mkdirSync(dst, { recursive: true });
  for (const file of fs.readdirSync(NATIVE)) {
    if (!file.endsWith('.kt')) continue;
    copyIfChanged(path.join(NATIVE, file), path.join(dst, file));
  }
  copyJniSources();
  copyResources();
  copyKeystore();
  patchMainActivity(dst);
}

// Copy the committed fixed signing keystore into the app module so
// app/build.gradle's signingConfigs.debug { storeFile
// file('claude-sessions.keystore') } resolves. Keeping one stable
// key across CI builds is what lets the user install updates over the
// top instead of uninstalling (which wipes saved sessions). The
// keystore is debug-grade with a well-known password — committing it
// is fine for a sideloaded personal app.
function copyKeystore() {
  const src = path.join(ROOT, 'android-keystore', 'claude-sessions.keystore');
  if (!fs.existsSync(src)) {
    console.warn('[android-init] no committed keystore; build will use a per-run debug key (updates may require uninstall)');
    return;
  }
  copyIfChanged(src, path.join(ANDROID, 'app', 'claude-sessions.keystore'));
}

// JNI C sources for the PTY library (Phase 1 of the local-shell
// support). Copies android-native/jni/* into
// android/app/src/main/cpp/ so the CMake build picks them up.
function copyJniSources() {
  const srcDir = path.join(NATIVE, 'jni');
  const dstDir = path.join(ANDROID, 'app', 'src', 'main', 'cpp');
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    copyIfChanged(path.join(srcDir, file), path.join(dstDir, file));
  }
}

// Android resource overlay. Anything we place under
// android-native/res/<resType>/<filename> overrides Capacitor's
// bundled version of the same resource at build time.
//
// Currently used for layout/bridge_layout_main.xml: that file makes
// the bridge's WebView a ClaudeSessionsWebView subclass so the
// custom InputConnection wrapper can intercept IME input. The bug
// it works around — Android WebView silently dropping IME composition
// events on xterm.js's hidden textarea — is documented in detail in
// android-native/TerminalInputConnection.kt.
function copyResources() {
  const srcRoot = path.join(NATIVE, 'res');
  if (!fs.existsSync(srcRoot)) return;
  const dstRoot = path.join(ANDROID, 'app', 'src', 'main', 'res');
  for (const resType of fs.readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, resType);
    const dstDir = path.join(dstRoot, resType);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    fs.mkdirSync(dstDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      copyIfChanged(path.join(srcDir, file), path.join(dstDir, file));
    }
  }
}

function patchMainActivity(pkgDir) {
  // Capacitor 7 only auto-discovers plugins shipped via npm. For
  // locally-added @CapacitorPlugin classes we have to call
  // registerPlugin() explicitly in MainActivity.onCreate(). The
  // generated MainActivity may be either Java or Kotlin depending
  // on the Capacitor version — handle both.
  const ktPath = path.join(pkgDir, 'MainActivity.kt');
  const javaPath = path.join(pkgDir, 'MainActivity.java');

  if (fs.existsSync(ktPath)) {
    const current = fs.readFileSync(ktPath, 'utf8');
    if (current.includes('registerPlugin(ComposeInputPlugin::class.java)')) return;
    const replacement = `package ${APP_PACKAGE}

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Register locally-defined Capacitor plugins BEFORE the
        // bridge initializes so the WebView sees them on first paint.
        registerPlugin(SshPlugin::class.java)
        registerPlugin(LocalShellPlugin::class.java)
        registerPlugin(ComposeInputPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
`;
    fs.writeFileSync(ktPath, replacement);
    console.log('[android-init] patched MainActivity.kt (Ssh + LocalShell + ComposeInput)');
    return;
  }

  if (fs.existsSync(javaPath)) {
    const current = fs.readFileSync(javaPath, 'utf8');
    if (current.includes('registerPlugin(ComposeInputPlugin.class)')) return;
    const replacement = `package ${APP_PACKAGE};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register locally-defined Capacitor plugins BEFORE the
        // bridge initializes so the WebView sees them on first paint.
        registerPlugin(SshPlugin.class);
        registerPlugin(LocalShellPlugin.class);
        registerPlugin(ComposeInputPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
    fs.writeFileSync(javaPath, replacement);
    console.log('[android-init] patched MainActivity.java (Ssh + LocalShell + ComposeInput)');
    return;
  }

  console.warn(`[android-init] no MainActivity.{kt,java} at ${pkgDir}; plugin won't be registered`);
}

// ---------------------------------------------------------------------
// 4. Gradle deps — sshj + androidx.core (for NotificationCompat)
// ---------------------------------------------------------------------

function patchAppGradle() {
  const buildGradle = path.join(ANDROID, 'app', 'build.gradle');
  if (!fs.existsSync(buildGradle)) {
    console.warn('[android-init] no app/build.gradle; skip gradle patch');
    return;
  }
  let g = fs.readFileSync(buildGradle, 'utf8');

  // Apply kotlin-android plugin so our .kt files in android-native/
  // actually compile. Capacitor 7's `cap add android` doesn't enable
  // Kotlin in the app module by default — without this, .kt files
  // are silently skipped at compile time and SshPlugin never makes
  // it into the APK (the WebView then has no Capacitor.Plugins.SSH
  // and ssh-bridge.js falls back to no-op stubs).
  const KOTLIN_PLUGIN_MARKER = 'claude-sessions: apply kotlin';
  if (!g.includes(KOTLIN_PLUGIN_MARKER) && !g.includes("apply plugin: 'kotlin-android'")) {
    const inject = `\n// ${KOTLIN_PLUGIN_MARKER}\napply plugin: 'kotlin-android'\n`;
    if (g.match(/apply plugin:\s*'com\.android\.application'/)) {
      g = g.replace(/apply plugin:\s*'com\.android\.application'/, (m) => `${m}${inject}`);
    } else {
      g = inject + g;
    }
  }

  // versionName from package.json + date-based versionCode so every CI
  // run gets a strictly higher number.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    g = g.replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
    const d = new Date();
    const code =
      d.getUTCFullYear() * 1000000 +
      (d.getUTCMonth() + 1) * 10000 +
      d.getUTCDate() * 100 +
      d.getUTCHours();
    g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`);
  } catch (_) {}

  // Insert our deps inside the existing `dependencies { … }` block.
  // We use a marker comment so re-runs don't duplicate the lines.
  //
  //   sshj                — remote SSH (SshPlugin)
  //   bcprov-jdk18on      — BouncyCastle provider, required so the
  //                         SshPlugin can swap out Android's partial
  //                         "BC" provider for the full implementation
  //                         (otherwise sshj's X25519 / curve25519-
  //                         sha256 KEX fails on every modern server).
  //                         sshj declares BC as runtimeOnly in its
  //                         own POM, so the class is NOT visible at
  //                         compile time unless we add it directly.
  //   androidx.core-ktx   — NotificationCompat for ForegroundService
  //   zstd-jni            — decompress assets/alpine-rootfs.tar.zst on
  //                         first launch of a local Linux session
  //   commons-compress    — TarArchiveInputStream for the same flow
  //                         (writing a tar parser by hand is doable
  //                         but commons-compress handles longlink /
  //                         posix headers / sparse files correctly)
  const MARKER = '// claude-sessions: native deps';
  if (!g.includes(MARKER)) {
    const inject = `
    ${MARKER}
    implementation 'com.hierynomus:sshj:0.39.0'
    implementation 'org.bouncycastle:bcprov-jdk18on:1.78.1'
    implementation 'androidx.core:core-ktx:1.13.1'
    implementation 'com.github.luben:zstd-jni:1.5.6-3@aar'
    implementation 'org.apache.commons:commons-compress:1.26.2'
    `;
    g = g.replace(/dependencies\s*\{/, (m) => `${m}\n${inject}`);
  }

  // sshj uses OkHttp-style snake-case package + BouncyCastle reflection
  // that runs into AGP's R8 minification. Disable R8 minify on debug
  // (it's debug only, no security cost) so missing-class-list noise
  // doesn't fail the build.
  if (!g.match(/buildTypes\s*\{[^}]*debug\s*\{[^}]*minifyEnabled\s*false/)) {
    g = g.replace(/buildTypes\s*\{/, (m) => `${m}\n        debug { minifyEnabled false }`);
  }

  // Stable signing key. Each CI runner otherwise auto-generates its
  // own ~/.android/debug.keystore, so every build is signed with a
  // DIFFERENT key — Android then refuses to install the new APK over
  // the old one ("signatures do not match") and the user has to
  // uninstall first, wiping all saved sessions. We commit one fixed
  // keystore (debug-grade, well-known password) and point the debug
  // signingConfig at it so every build shares a signature → updates
  // install over the top and preserve data.
  const SIGNING_MARKER = '// claude-sessions: stable signing';
  if (!g.includes(SIGNING_MARKER)) {
    g = g.replace(/android\s*\{/, (m) => `${m}
    ${SIGNING_MARKER}
    signingConfigs {
        debug {
            storeFile file('claude-sessions.keystore')
            storePassword 'android'
            keyAlias 'claudesessions'
            keyPassword 'android'
        }
    }
`);
  }

  // Native PTY library (jni/pty.c → libclaudesessions_pty.so) for
  // the LocalShellPlugin. We restrict to arm64-v8a (~99% of modern
  // Android devices) to keep the APK small and the build matrix
  // boring; older armv7 / x86_64 would need separate cross compiles.
  const CMAKE_MARKER = '// claude-sessions: cmake native build';
  if (!g.includes(CMAKE_MARKER)) {
    // Insert into defaultConfig: ndk { abiFilters } + externalNativeBuild cmake hint
    g = g.replace(/defaultConfig\s*\{/, (m) => `${m}
        ${CMAKE_MARKER}
        ndk { abiFilters 'arm64-v8a' }
        externalNativeBuild { cmake { cppFlags '' } }
`);
    // Insert into android { ... }: top-level externalNativeBuild that
    // points at our CMakeLists.txt.
    g = g.replace(/android\s*\{/, (m) => `${m}
    ${CMAKE_MARKER}
    externalNativeBuild {
        cmake {
            path 'src/main/cpp/CMakeLists.txt'
            version '3.22.1'
        }
    }
    ndkVersion '26.1.10909125'
`);
  }

  // Tell AAPT not to recompress the bundled Linux env assets. The tar
  // is zstd-compressed already; re-zipping it costs APK install time
  // for zero size win. proot-arm64 is a stripped ELF — also doesn't
  // benefit from deflate. Keeping them uncompressed inside the APK
  // also lets AssetManager return a real fd (openFd) so the plugin
  // can stream-extract without buffering the whole 50 MB in RAM.
  const NOCOMPRESS_MARKER = '// claude-sessions: noCompress linux assets';
  if (!g.includes(NOCOMPRESS_MARKER)) {
    g = g.replace(/android\s*\{/, (m) => `${m}
    ${NOCOMPRESS_MARKER}
    androidResources {
        noCompress 'zst'
        noCompress 'tar.zst'
    }
`);
  }

  // BouncyCastle (transitive dep of sshj) ships 3 jars — bcprov,
  // bcutil, bcpkix — each with their own OSGi manifest at the same
  // path inside META-INF/versions/9/. AGP's resource merger sees the
  // duplicates and bails. The manifests are OSGi metadata that the
  // Android runtime never reads, so just exclude them and the usual
  // license-file siblings that also tend to collide.
  const PKG_MARKER = '// claude-sessions: packaging excludes';
  if (!g.includes(PKG_MARKER)) {
    const inject = `
    ${PKG_MARKER}
    packaging {
        resources {
            excludes += [
                'META-INF/versions/9/OSGI-INF/MANIFEST.MF',
                'META-INF/versions/9/OSGI-INF/**',
                'META-INF/INDEX.LIST',
                'META-INF/DEPENDENCIES',
                'META-INF/LICENSE',
                'META-INF/LICENSE.txt',
                'META-INF/NOTICE',
                'META-INF/NOTICE.txt',
            ]
        }
    }`;
    g = g.replace(/android\s*\{/, (m) => `${m}\n${inject}`);
  }

  fs.writeFileSync(buildGradle, g);
  console.log('[android-init] patched app/build.gradle');
}

// ---------------------------------------------------------------------
// 4b. Project-level build.gradle — Kotlin gradle plugin classpath
// ---------------------------------------------------------------------

function patchProjectGradle() {
  const buildGradle = path.join(ANDROID, 'build.gradle');
  if (!fs.existsSync(buildGradle)) {
    console.warn('[android-init] no project build.gradle; skip kotlin classpath patch');
    return;
  }
  let g = fs.readFileSync(buildGradle, 'utf8');
  const MARKER = '// claude-sessions: kotlin gradle classpath';
  if (g.includes(MARKER) || g.includes('kotlin-gradle-plugin')) return;

  // We want to add the Kotlin gradle plugin to buildscript.dependencies.
  // Typical Capacitor 7 project build.gradle has:
  //   buildscript {
  //     dependencies {
  //         classpath 'com.android.tools.build:gradle:8.x.x'
  //     }
  //   }
  // We inject our classpath line right after the AGP one.
  const KOTLIN_VERSION = '1.9.22';
  if (g.match(/classpath\s+['"]com\.android\.tools\.build:gradle:[^'"]+['"]/)) {
    g = g.replace(
      /(classpath\s+['"]com\.android\.tools\.build:gradle:[^'"]+['"])/,
      (m) => `${m}\n        ${MARKER}\n        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"`,
    );
  } else if (g.match(/dependencies\s*\{/)) {
    // No AGP classpath visible — add to first dependencies block instead.
    g = g.replace(
      /dependencies\s*\{/,
      (m) => `${m}\n        ${MARKER}\n        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"`,
    );
  } else {
    // Fall back to a buildscript block at the top.
    g = `buildscript {\n    repositories { google(); mavenCentral() }\n    dependencies {\n        ${MARKER}\n        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"\n    }\n}\n\n` + g;
  }
  fs.writeFileSync(buildGradle, g);
  console.log('[android-init] patched project build.gradle (kotlin classpath)');
}

// ---------------------------------------------------------------------
// 5. AndroidManifest — service + permissions
// ---------------------------------------------------------------------

function patchManifest() {
  const manifest = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return;
  let m = fs.readFileSync(manifest, 'utf8');

  const perms = [
    'android.permission.INTERNET',
    'android.permission.FOREGROUND_SERVICE',
    // dataSync is the broadest specific-FGS category that covers
    // "keep our SSH connection alive" on Android 14+.
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
  ];
  for (const p of perms) {
    if (!m.includes(p)) {
      m = m.replace(/<manifest[^>]*>/, (head) => `${head}\n    <uses-permission android:name="${p}" />`);
    }
  }

  // Declare the foreground service. Android 14+ wants
  // foregroundServiceType so the OS knows why we're staying alive.
  const serviceTag = `<service android:name=".ForegroundService"
            android:foregroundServiceType="dataSync"
            android:exported="false" />`;
  if (!m.includes('ForegroundService')) {
    m = m.replace(/<\/application>/, `    ${serviceTag}\n    </application>`);
  }

  // adjustResize so the soft keyboard pushes the whole layout up,
  // keeping the native compose bar (bottom of bridge_layout_main.xml)
  // visible right above the keyboard instead of hidden behind it.
  if (/android:windowSoftInputMode=/.test(m)) {
    m = m.replace(/android:windowSoftInputMode="[^"]*"/, 'android:windowSoftInputMode="adjustResize"');
  } else {
    // Add it to the MainActivity tag.
    m = m.replace(/(<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*)>/,
      (full, head) => `${head} android:windowSoftInputMode="adjustResize">`);
  }

  fs.writeFileSync(manifest, m);
  console.log('[android-init] patched AndroidManifest.xml');
}

// ---------------------------------------------------------------------
// 6. Lower targetSdkVersion to 28
// ---------------------------------------------------------------------
//
// Android 10+ (targetSdk ≥ 29) enforces a SELinux policy that denies
// `execute` on files labeled `app_data_file:s0` from the
// `untrusted_app` domain. Translation: at targetSdk 29+ we can't
// exec(2) the proot binary we wrote to filesDir, nor can proot then
// re-exec /bin/sh from inside the bundled rootfs. Both fail with
// EACCES ("Permission denied"), which manifested on the first user
// test as:
//
//   [pty] exec /data/user/0/.../files/proot-arm64 failed: Permission
//         denied
//   [Session ended (exit 127)]
//
// Termux, UserLAnd, AnLinux, and every other "Linux on Android" app
// pin targetSdkVersion to 28 to opt out of this restriction. We do
// the same here — it's the only path that keeps the WHOLE rootfs
// usable, not just the proot binary.
//
// Side effects of targetSdk 28 we accept:
//   - No scoped storage on Android 10+ (we don't use external
//     storage from the APK directly; users access /sdcard through
//     the proot bind mount).
//   - FOREGROUND_SERVICE_DATA_SYNC subtype isn't enforced (it's only
//     required at targetSdk ≥ 34). We leave the permission declared
//     so Android 14+ behaves nicely if we ever raise the target.
//   - Notification channels still work (we use NotificationCompat).
//
// Capacitor 7 stores SDK levels in android/variables.gradle as
// `ext.targetSdkVersion`. app/build.gradle references it via
// rootProject.ext.targetSdkVersion, so patching variables.gradle is
// the canonical lever.

function patchTargetSdk() {
  const variablesGradle = path.join(ANDROID, 'variables.gradle');
  const appGradle = path.join(ANDROID, 'app', 'build.gradle');

  // Primary lever: variables.gradle (Capacitor 7's convention).
  if (fs.existsSync(variablesGradle)) {
    let v = fs.readFileSync(variablesGradle, 'utf8');
    const before = v;
    v = v.replace(/targetSdkVersion\s*=\s*\d+/g, 'targetSdkVersion = 28');
    if (v !== before) {
      fs.writeFileSync(variablesGradle, v);
      console.log('[android-init] patched android/variables.gradle: targetSdkVersion = 28');
      return;
    }
  }

  // Fallback: write targetSdkVersion directly into app/build.gradle.
  // We force it via an `override`-style approach: an explicit line
  // inside defaultConfig wins over the rootProject.ext reference.
  if (fs.existsSync(appGradle)) {
    let g = fs.readFileSync(appGradle, 'utf8');
    const MARKER = '// claude-sessions: targetSdk pin';
    if (g.includes(MARKER)) return;
    g = g.replace(/defaultConfig\s*\{/, (m) => `${m}
        ${MARKER}
        targetSdkVersion 28
`);
    fs.writeFileSync(appGradle, g);
    console.log('[android-init] patched app/build.gradle: targetSdkVersion 28');
  }
}

// ---------------------------------------------------------------------
// run
// ---------------------------------------------------------------------

vendorXterm();
ensureCapacitorProject();
copyNativeSources();
patchProjectGradle();
patchAppGradle();
patchManifest();
patchTargetSdk();

// One more cap sync now that natives are in place so Capacitor's
// plugin discovery picks them up before gradle runs.
run('npx --yes cap sync android');

console.log('[android-init] done. Next:  cd android && ./gradlew assembleDebug');
