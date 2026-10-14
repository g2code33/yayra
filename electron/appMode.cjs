/**
 * "Install page as app..." - Chrome-style site installation.
 *
 * Chrome's feature boils down to: (1) an OS launcher entry (desktop +
 * applications menu / Start Menu) that (2) launches the browser with
 * `--app=<url>`, which (3) opens the site in its own minimal app window
 * instead of a browser tab. This module holds the PURE, unit-testable
 * parts: parsing the --app= flag out of argv and building the exact
 * install artifacts for each platform. electron/main.cjs executes the
 * plan (writes files / shell.writeShortcutLink) and opens app windows.
 */

const crypto = require('node:crypto');

/** Extract a safe https?:// url from a `--app=<url>` argv flag, or null. */
function parseAppModeUrl(argv) {
  for (const arg of argv || []) {
    if (typeof arg !== 'string' || !arg.startsWith('--app=')) continue;
    const raw = arg.slice('--app='.length).replace(/^["']|["']$/g, '');
    // http(s) only - never file:, javascript:, chrome:, custom schemes.
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      return new URL(raw).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** Launcher-safe display name derived from the page title (or host). */
function sanitizeAppName(title, url) {
  let fallback = 'Yayra app';
  try { fallback = new URL(url).hostname || fallback; } catch { /* keep default */ }
  const name = String(title || fallback)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return name || fallback;
}

/**
 * Stable per-URL window class for an installed site app. Used as the X11
 * WM_CLASS of the window the app-mode launch opens (via Chromium's
 * --class switch, set before app ready in electron/main.cjs) AND as the
 * StartupWMClass of the .desktop entries buildInstallPlan writes - the
 * two must match exactly, or GNOME/KDE show the site window with a
 * GENERIC icon and never group it under its launcher. Keyed by the URL
 * (not the display name) so the same site always maps to the same class
 * no matter how the user renamed the install.
 */
function appWindowClass(url) {
  try {
    const normalized = new URL(String(url)).toString();
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
    return `yayra-app-${hash}`;
  } catch {
    return 'yayra-app';
  }
}

/** Filesystem-safe slug for artifact filenames. */
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

/**
 * Build the per-platform install plan. Returns
 *   { ok:true, name, artifacts:[...] } or { ok:false, reason }.
 * Artifacts:
 *   { kind:'file', path, contents, executable? }       (Linux .desktop)
 *   { kind:'shortcut', path, options }                 (Windows .lnk via shell.writeShortcutLink)
 * Linux gets BOTH a desktop icon and an applications-menu entry - that
 * applications entry is what makes it feel "installed" like a PWA.
 */
function buildInstallPlan({ platform, execPath, url, title, desktopDir, applicationsDir = null, startMenuDir = null, iconPath = null }) {
  if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, reason: 'invalid-url' };
  let normalized;
  try { normalized = new URL(url).toString(); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (!execPath || !desktopDir) return { ok: false, reason: 'missing-paths' };

  const name = sanitizeAppName(title, normalized);
  const slug = slugify(name);
  const join = (dir, file) => `${String(dir).replace(/[\\/]+$/, '')}${platform === 'win32' ? '\\' : '/'}${file}`;

  if (platform === 'linux') {
    const contents = '[Desktop Entry]\n'
      + 'Type=Application\n'
      + `Name=${name}\n`
      + `Comment=${name} - installed with Yayra\n`
      + `Exec="${execPath}" --app="${normalized}"\n`
      + 'Terminal=false\n'
      + (iconPath ? `Icon=${iconPath}\n` : '')
      + 'Categories=Network;WebBrowser;\n'
      // Must equal the window's real WM_CLASS (appWindowClass above +
      // the --class switch in main.cjs) - a class no window ever has
      // leaves the site window ungrouped with a generic dock icon.
      + `StartupWMClass=${appWindowClass(normalized)}\n`;
    const artifacts = [
      { kind: 'file', path: join(desktopDir, `${name}.desktop`), contents, executable: true }
    ];
    if (applicationsDir) {
      // The applications-menu entry = shows up in the OS app launcher.
      artifacts.push({ kind: 'file', path: join(applicationsDir, `yayra-app-${slug}.desktop`), contents, executable: true });
    }
    return { ok: true, name, inLauncher: Boolean(applicationsDir), artifacts };
  }

  if (platform === 'win32') {
    const options = {
      target: execPath,
      args: `--app="${normalized}"`,
      description: `${name} - installed with Yayra`,
      ...(iconPath ? { icon: iconPath, iconIndex: 0 } : {})
    };
    const artifacts = [
      { kind: 'shortcut', path: join(desktopDir, `${name}.lnk`), options }
    ];
    if (startMenuDir) {
      artifacts.push({ kind: 'shortcut', path: join(startMenuDir, `${name}.lnk`), options });
    }
    return { ok: true, name, inLauncher: Boolean(startMenuDir), artifacts };
  }

  // macOS needs a real .app bundle to do this honestly - not shipped yet.
  return { ok: false, reason: 'unsupported-platform' };
}

module.exports = { parseAppModeUrl, sanitizeAppName, buildInstallPlan, appWindowClass };
