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
  patchMainActivity(dst);
}

function patchMainActivity(pkgDir) {
  // Capacitor 7 only auto-discovers plugins shipped via npm. For
  // locally-added @CapacitorPlugin classes we have to call
  // registerPlugin() explicitly in MainActivity.onCreate(). The
  // generated MainActivity is tiny (extends BridgeActivity with no
  // body); we rewrite it idempotently if it doesn't already do the
  // registration.
  const main = path.join(pkgDir, 'MainActivity.kt');
  if (!fs.existsSync(main)) {
    console.warn(`[android-init] no MainActivity.kt at ${main}; plugin won't be registered`);
    return;
  }
  const current = fs.readFileSync(main, 'utf8');
  if (current.includes('registerPlugin(SshPlugin::class.java)')) return;

  const replacement = `package ${APP_PACKAGE}

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Register the locally-defined SSH plugin before Capacitor's
        // bridge initializes so the WebView sees Capacitor.Plugins.SSH
        // immediately on first paint.
        registerPlugin(SshPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
`;
  fs.writeFileSync(main, replacement);
  console.log('[android-init] patched MainActivity.kt to register SshPlugin');
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
  const MARKER = '// claude-sessions: native deps';
  if (!g.includes(MARKER)) {
    const inject = `
    ${MARKER}
    implementation 'com.hierynomus:sshj:0.39.0'
    implementation 'androidx.core:core-ktx:1.13.1'
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

  fs.writeFileSync(buildGradle, g);
  console.log('[android-init] patched app/build.gradle');
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

  fs.writeFileSync(manifest, m);
  console.log('[android-init] patched AndroidManifest.xml');
}

// ---------------------------------------------------------------------
// run
// ---------------------------------------------------------------------

vendorXterm();
ensureCapacitorProject();
copyNativeSources();
patchAppGradle();
patchManifest();

// One more cap sync now that natives are in place so Capacitor's
// plugin discovery picks them up before gradle runs.
run('npx --yes cap sync android');

console.log('[android-init] done. Next:  cd android && ./gradlew assembleDebug');
