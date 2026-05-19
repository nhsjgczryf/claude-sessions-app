#!/usr/bin/env node
// Idempotent bootstrap for the Android (Capacitor) project.
//
//   - If `android/` doesn't exist yet, runs `npx cap add android` to
//     scaffold it from capacitor.config.json + web-android/.
//   - Always runs `npx cap sync android` to refresh the bundled assets
//     and plugin wiring.
//   - Patches a couple of build settings that Capacitor doesn't expose
//     directly: app name from the manifest, and the launcher icon.
//
// Run via `npm run android:init` or as the first step of
// `npm run android:build`.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');

function run(cmd, opts = {}) {
  console.log('[android-init] $', cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

if (!fs.existsSync(ANDROID)) {
  run('npx --yes cap add android');
} else {
  console.log('[android-init] android/ already exists; skipping cap add');
}

run('npx --yes cap sync android');

// Patch versionName / versionCode from package.json so APK reflects
// the project version automatically.
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const buildGradle = path.join(ANDROID, 'app', 'build.gradle');
  if (fs.existsSync(buildGradle)) {
    let g = fs.readFileSync(buildGradle, 'utf8');
    g = g.replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
    // versionCode bumped by date (YYYYMMDDhh) so each CI build gets
    // a monotonically-increasing code without us tracking it manually.
    const d = new Date();
    const code =
      d.getUTCFullYear() * 1000000 +
      (d.getUTCMonth() + 1) * 10000 +
      d.getUTCDate() * 100 +
      d.getUTCHours();
    g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`);
    fs.writeFileSync(buildGradle, g);
    console.log(`[android-init] versionName=${pkg.version} versionCode=${code}`);
  }
} catch (e) {
  console.warn('[android-init] gradle version patch skipped:', e.message);
}

console.log('[android-init] done. Next:  cd android && ./gradlew assembleDebug');
