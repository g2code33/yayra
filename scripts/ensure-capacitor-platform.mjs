#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { updateIosProjectVersion } from './lib/ios-project.mjs';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) {
  console.error('usage: node scripts/ensure-capacitor-platform.mjs <android|ios>');
  process.exit(2);
}
const root = process.cwd();
if (!existsSync(path.join(root, platform))) {
  const add = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap', 'add', platform], { cwd: root, stdio: 'inherit' });
  if (add.status !== 0) process.exit(add.status || 1);
}
// --- Google sign-in deep-link callback (docs/GOOGLE_SIGNIN.md) -----------
// The OAuth flow returns to the app on the custom URL scheme
// `com.yayra.app:/oauth2redirect` (RFC 8252 §7.1). Capacitor's generated
// projects do NOT register a handler for their own custom_url_scheme out
// of the box, and android/ + ios/ are generated/gitignored - so the
// registration is (re)injected here, idempotently, every time the platform
// is ensured, instead of being a manual step someone forgets.
const OAUTH_MARKER = 'YAYRA GOOGLE SIGN-IN DEEP LINK';

async function injectAndroidUrlSchemeIntentFilter() {
  const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  if (!existsSync(manifestPath)) return;
  let manifest = await readFile(manifestPath, 'utf8');
  if (manifest.includes(OAUTH_MARKER)) return;
  const intentFilter = `
            <!-- ${OAUTH_MARKER}: injected by scripts/ensure-capacitor-platform.mjs.
                 Routes com.yayra.app:/oauth2redirect (Google OAuth callback,
                 @string/custom_url_scheme) back into the app as an
                 App.appUrlOpen event. autoVerify is NOT set: this is a
                 custom scheme, not an https app link. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="@string/custom_url_scheme" />
            </intent-filter>
`;
  const closingActivity = /(\n\s*<\/activity>)/;
  if (!closingActivity.test(manifest)) throw new Error('MainActivity </activity> not found in AndroidManifest.xml');
  manifest = manifest.replace(closingActivity, `\n${intentFilter}$1`);
  await writeFile(manifestPath, manifest);
  console.log('injected Google sign-in intent-filter into AndroidManifest.xml');
}

async function injectIosUrlScheme() {
  const plistPath = path.join(root, 'ios/App/App/Info.plist');
  if (!existsSync(plistPath)) return;
  let plist = await readFile(plistPath, 'utf8');
  if (plist.includes(OAUTH_MARKER)) return;
  const urlTypes = `\t<!-- ${OAUTH_MARKER}: injected by scripts/ensure-capacitor-platform.mjs.
\t     Registers the com.yayra.app custom scheme so Google's OAuth redirect
\t     reopens the app (surfaced as App.appUrlOpen). -->
\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLName</key>
\t\t\t<string>com.yayra.app</string>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>com.yayra.app</string>
\t\t\t</array>
\t\t</dict>
\t</array>
`;
  if (plist.includes('<key>CFBundleURLTypes</key>')) {
    console.warn('Info.plist already declares CFBundleURLTypes; verify the com.yayra.app scheme is present (docs/GOOGLE_SIGNIN.md)');
    return;
  }
  const closingDict = /(\n<\/dict>\n<\/plist>)/;
  if (!closingDict.test(plist)) throw new Error('closing </dict></plist> not found in Info.plist');
  plist = plist.replace(closingDict, `\n${urlTypes}$1`);
  await writeFile(plistPath, plist);
  console.log('injected Google sign-in URL scheme into Info.plist');
}

async function syncIosVersion() {
  const projectPath = path.join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  if (!existsSync(projectPath)) return;

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const result = updateIosProjectVersion(await readFile(projectPath, 'utf8'), pkg.version);
  await writeFile(projectPath, result.project);
  console.log(`synced iOS project version ${pkg.version} (${result.buildNumber})`);
}

// --- System-wide floating bubble (SYSTEM_ALERT_WINDOW overlay) -----------
// The bubble must float over EVERY opened app - a real OS-level overlay
// (same mechanism as Messenger chat heads), not a <div> inside Yayra's own
// WebView. The native stack already lives in packages/floating-android
// (foreground Service + WindowManager TYPE_APPLICATION_OVERLAY views + the
// YayraOverlayPlugin Capacitor bridge); android/ is generated/gitignored,
// so everything is (re)installed here idempotently on every build:
//   1. Kotlin sources copied into the app module
//   2. Kotlin gradle plugin enabled (Capacitor's template is Java-only)
//   3. Manifest permissions + <service> entry injected
//   4. Plugin registered in MainActivity
//   5. Brand logo installed as the bubble drawable (logo-ONLY bubble)
const OVERLAY_MARKER = 'YAYRA FLOATING BUBBLE OVERLAY';

async function installAndroidOverlayNative() {
  if (!existsSync(path.join(root, 'android'))) return;

  // 1. Kotlin sources -> android/app/src/main/java/com/yayra/floating/...
  const ktSrc = path.join(root, 'packages/floating-android/src/kotlin/com');
  const ktDest = path.join(root, 'android/app/src/main/java/com');
  if (existsSync(ktSrc)) {
    await cp(ktSrc, ktDest, { recursive: true, force: true });
    console.log('copied floating-bubble Kotlin sources into android/app');
  }

  // 2. Brand logo as the bubble drawable (drawable names must be lowercase).
  const logoSrc = path.join(root, 'assets/brand/logomain1-transparent.png');
  const drawableDir = path.join(root, 'android/app/src/main/res/drawable');
  if (existsSync(logoSrc)) {
    await mkdir(drawableDir, { recursive: true });
    await cp(logoSrc, path.join(drawableDir, 'yayra_bubble_logo.png'));
  }

  // 3. Kotlin gradle support (idempotent).
  const rootGradle = path.join(root, 'android/build.gradle');
  if (existsSync(rootGradle)) {
    let gradle = await readFile(rootGradle, 'utf8');
    if (!gradle.includes('kotlin-gradle-plugin')) {
      gradle = gradle.replace(
        /(dependencies\s*\{)/,
        `$1\n        // ${OVERLAY_MARKER}: Kotlin support for the native bubble sources\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25'`
      );
      await writeFile(rootGradle, gradle);
      console.log('enabled Kotlin gradle plugin classpath in android/build.gradle');
    }
  }
  const appGradle = path.join(root, 'android/app/build.gradle');
  if (existsSync(appGradle)) {
    let gradle = await readFile(appGradle, 'utf8');
    if (!gradle.includes("apply plugin: 'kotlin-android'")) {
      gradle = gradle.replace(
        /(apply plugin: 'com\.android\.application')/,
        `$1\n// ${OVERLAY_MARKER}\napply plugin: 'kotlin-android'`
      );
      await writeFile(appGradle, gradle);
      console.log("applied kotlin-android plugin in android/app/build.gradle");
    }
  }

  // 4. Manifest: overlay/service permissions + the foreground service.
  const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  if (existsSync(manifestPath)) {
    let manifest = await readFile(manifestPath, 'utf8');
    if (!manifest.includes(OVERLAY_MARKER)) {
      const permissions = `
    <!-- ${OVERLAY_MARKER}: injected by scripts/ensure-capacitor-platform.mjs.
         SYSTEM_ALERT_WINDOW = draw the bubble over every other app (the user
         grants it on the system "Display over other apps" page, reached via
         YayraOverlay.requestPermission()). RECORD_AUDIO supports Google voice
         search; the FGS + notification permissions keep the user-controlled
         bubble service alive and visible per Android 13-15 policy. -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="com.android.launcher.permission.INSTALL_SHORTCUT" />
`;
      const service = `
        <!-- ${OVERLAY_MARKER}: user-controlled foreground service hosting the
             system-wide floating bubble + floating mini browser window. -->
        <service
            android:name="com.yayra.floating.android.YayraFloatBubbleService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="User-controlled floating browser bubble (AssistiveTouch-style quick access over other apps)" />
        </service>
`;
      if (!/<\/application>/.test(manifest)) throw new Error('</application> not found in AndroidManifest.xml');
      manifest = manifest.replace(/(\n\s*<application)/, `\n${permissions}$1`);
      manifest = manifest.replace(/(\n\s*<\/application>)/, `\n${service}$1`);
      await writeFile(manifestPath, manifest);
      console.log('injected floating-bubble permissions + service into AndroidManifest.xml');
    }
    // Existing generated projects already contain OVERLAY_MARKER, so new
    // voice-search builds must backfill RECORD_AUDIO independently.
    if (!manifest.includes('android.permission.RECORD_AUDIO')) {
      manifest = manifest.replace(
        /(\n\s*<application)/,
        '\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n$1'
      );
      await writeFile(manifestPath, manifest);
      console.log('injected Google voice-search audio permission into AndroidManifest.xml');
    }
  }

  // 5. Register the Capacitor plugin in MainActivity.
  const mainActivity = path.join(root, 'android/app/src/main/java/com/yayra/app/MainActivity.java');
  if (existsSync(mainActivity)) {
    let java = await readFile(mainActivity, 'utf8');
    if (!java.includes('YayraOverlayPlugin')) {
      const defaultBody = /public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/;
      if (defaultBody.test(java)) {
        java = java.replace(
          defaultBody,
          `public class MainActivity extends BridgeActivity {
    // ${OVERLAY_MARKER}: registers the system-wide floating bubble bridge.
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(com.yayra.floating.android.YayraOverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}`
        );
        await writeFile(mainActivity, java);
        console.log('registered YayraOverlayPlugin in MainActivity.java');
      } else {
        console.warn('MainActivity.java was customized - add registerPlugin(YayraOverlayPlugin.class) in onCreate manually (docs/android-floating-bubble.md)');
      }
    }
  }
}

if (platform === 'android') {
  await injectAndroidUrlSchemeIntentFilter();
  await installAndroidOverlayNative();
  // --- Launcher icon: the COMPLETE set, not just the legacy PNG. ---------
  // Android 8+ (every modern device) ignores ic_launcher.png whenever
  // mipmap-anydpi-v26/ic_launcher.xml exists: the adaptive icon XML wins,
  // and Capacitor's template XML points at ic_launcher_foreground +
  // ic_launcher_background - which used to stay the Capacitor defaults.
  // That is exactly why the APK showed the wrong/missing logo. Now every
  // layer is installed: legacy PNGs, round PNGs, adaptive foregrounds
  // (brand logo inside the 66dp safe zone), the background colour, and
  // the anydpi-v26 XMLs are rewritten to reference them.
  if (existsSync(path.join(root, 'android'))) {
    const resRoot = path.join(root, 'android/app/src/main/res');
    for (const density of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
      const srcDir = path.join(root, 'native-assets/android', density);
      const destDir = path.join(resRoot, density);
      await mkdir(destDir, { recursive: true });
      for (const file of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
        const src = path.join(srcDir, file);
        if (existsSync(src)) await cp(src, path.join(destDir, file));
      }
    }
    // Adaptive icon XMLs (overwrite the template's so they always point at
    // the brand assets just installed).
    const anydpi = path.join(resRoot, 'mipmap-anydpi-v26');
    await mkdir(anydpi, { recursive: true });
    const adaptiveXml = '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
      + '    <background android:drawable="@color/ic_launcher_background"/>\n'
      + '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
      + '</adaptive-icon>\n';
    await writeFile(path.join(anydpi, 'ic_launcher.xml'), adaptiveXml);
    await writeFile(path.join(anydpi, 'ic_launcher_round.xml'), adaptiveXml);
    // Brand backdrop behind the transparent logo foreground.
    const valuesDir = path.join(resRoot, 'values');
    await mkdir(valuesDir, { recursive: true });
    await writeFile(
      path.join(valuesDir, 'ic_launcher_background.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B1220</color>\n</resources>\n'
    );
    console.log('installed complete Android launcher icon set (legacy + round + adaptive foreground/background)');
  }
}
if (platform === 'ios') {
  await injectIosUrlScheme();
  await syncIosVersion();
  const src = path.join(root, 'native-assets/ios/AppIcon.appiconset');
  const dest = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
  if (existsSync(src) && existsSync(path.join(root, 'ios'))) {
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
  }
  const exportOptions = path.join(root, 'ios/exportOptions.plist');
  if (!existsSync(exportOptions)) {
    await writeFile(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>method</key><string>development</string><key>signingStyle</key><string>automatic</string></dict></plist>\n`);
  }
}
console.log(`capacitor ${platform} platform is present and icon assets are synced`);
