import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// The dev app checks for updates against its own origin
// (/updates/manifest.json - see getUpdateManifestUrl() in
// src/browser/main.js). Serve a live manifest built from the CURRENT
// package.json version so the in-app update system responds in dev:
// normally that means "Yayra is up to date (vX.Y.Z)". To rehearse the
// "update available" flow end-to-end, start the server with
// YAYRA_DEV_UPDATE_LATEST=9.9.9 (any semver newer than package.json).
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function buildDevUpdateManifest() {
  const latest = (process.env.YAYRA_DEV_UPDATE_LATEST || '').trim() || PKG_VERSION;
  const targets = ['windows', 'linux', 'ios', 'android', 'pwa'];
  const fill = (version) => Object.fromEntries(targets.map((t) => [t, version]));
  return {
    schema: 1,
    channel: 'stable',
    latest: fill(latest),
    minSupported: fill('0.1.0'),
    downloads: {},
    notes: { en: latest === PKG_VERSION ? 'Dev preview manifest (live, generated per request).' : `Dev-simulated update to ${latest} (YAYRA_DEV_UPDATE_LATEST).` },
    rollout: { percent: 100, allowlist: [] },
    publishedAt: new Date().toISOString(),
    ttlSeconds: 0
  };
}


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Allow all hosts and iframe embedding for preview
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // Voice search is user-initiated and needs the preview origin to be
  // allowed to request its own microphone. Embedding parents may still
  // apply a stricter policy; opening the preview directly always works.
  res.setHeader('Permissions-Policy', 'microphone=(self)');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '/index.html') {
    serveBrowserApp(res);
    return;
  }

  if (reqPath === '/api/status') {    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      app: 'Yayra FloatBrowse',
      version: PKG_VERSION,
      status: 'operational',
      ui: 'Browser-First (Chrome Desktop & Safari Mobile Layout)',
      desktopModes: ['circle-first', 'browser-first'],
      displaySession: process.env.WAYLAND_DISPLAY ? 'Wayland' : 'X11',
      time: new Date().toISOString()
    }));
    return;
  }

  // In-app update checks: respond with a live manifest for the CURRENT
  // dev version (see buildDevUpdateManifest above). Previously this path
  // 404'd (the static fallback below maps to <repo>/updates/... which
  // doesn't exist - the bundled copy lives under public/), so every dev
  // update check landed in the "could not reach the update server" state.
  if (reqPath === '/updates/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    res.end(JSON.stringify(buildDevUpdateManifest(), null, 2));
    return;
  }

  // The update telemetry beacon (navigator.sendBeacon POSTs). Accept and
  // discard so dev consoles stay free of 404 noise.
  if (reqPath === '/telemetry/updates') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Give the live preview a root-scoped manifest so the current dev app can
  // be installed as a PWA without pretending it is a release deployment.
  if (reqPath === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    res.end(JSON.stringify({
      name: 'yayra dev preview',
      short_name: 'yayra dev',
      id: '/?dev=yayra',
      start_url: '/?dev=yayra',
      scope: '/',
      display: 'standalone',
      background_color: '#060b19',
      theme_color: '#172554',
      icons: [
        { src: '/assets/brand/logomain1-transparent.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
        { src: '/assets/brand/logomain1.jpg', sizes: '1024x1024', type: 'image/jpeg', purpose: 'any' }
      ]
    }));
    return;
  }

  // The Google sign-in callback page lives under public/ (served from the
  // deployment root in production builds). Map it here too so the Web/PWA
  // OAuth flow is testable against the dev server with a localhost redirect
  // URI (see docs/GOOGLE_SIGNIN.md). Build placeholders are filled from the
  // same env vars scripts/build-web.mjs uses; unset means "not configured"
  // and the page reports that honestly.
  if (reqPath === '/auth/callback' || reqPath === '/auth/callback/' || reqPath === '/auth/callback/index.html') {
    const callbackFile = path.join(rootDir, 'public', 'auth', 'callback', 'index.html');
    fs.readFile(callbackFile, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const page = html
        .replaceAll('__BUILD_VERSION__', 'dev')
        // Empty CSP meta = no directives = unrestricted, fine for local dev.
        .replaceAll('__CSP__', '')
        .replaceAll('__GOOGLE_WEB_CLIENT_ID__', (process.env.YAYRA_GOOGLE_WEB_CLIENT_ID || '').trim())
        .replaceAll('__GOOGLE_AUTH_EXCHANGE_URL__', (process.env.YAYRA_GOOGLE_AUTH_EXCHANGE_URL || '').trim());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      res.end(page);
    });
    return;
  }

  // Static file serving from workspace
  let filePath = path.join(rootDir, reqPath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      // Production deployments serve public/ from the site root; mirror
      // that here so root-relative assets (favicons, /auth pages, the
      // bundled update manifest fallback, ...) resolve in dev too.
      const publicPath = path.join(rootDir, 'public', reqPath);
      if (publicPath.startsWith(path.join(rootDir, 'public')) && fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
        const pubExt = path.extname(publicPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[pubExt] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0' });
        fs.createReadStream(publicPath).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const requestedFile = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.stat(requestedFile, (fileErr, fileStats) => {
      if (fileErr || !fileStats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(requestedFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store, max-age=0' });
      fs.createReadStream(requestedFile).pipe(res);
    });
  });
});

function serveBrowserApp(res) {
  // Query-bust the entry module as an extra guard against a stale preview or
  // an older service worker that cached the previous dev shell.
  const devToken = Date.now().toString(36);
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-version="${PKG_VERSION}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="theme-color" content="#172554">
  <meta name="yayra-google-web-client-id" content="${(process.env.YAYRA_GOOGLE_WEB_CLIENT_ID || '').trim()}">
  <meta name="yayra-google-auth-exchange-url" content="${(process.env.YAYRA_GOOGLE_AUTH_EXCHANGE_URL || '').trim()}">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="1024x1024" href="/assets/brand/logomain1-transparent.png">
  <link rel="icon" type="image/jpeg" sizes="1024x1024" href="/assets/brand/logomain1.jpg">
  <!-- Match public/index.html's production cascade so legacy-style leaks
       into BrowserShell popovers are visible (and testable) in dev too. -->
  <link rel="stylesheet" href="/styles.css?dev=${devToken}">
  <link rel="stylesheet" href="/packages/shared-ui/src/theme/design-system.css?dev=${devToken}">
  <link rel="stylesheet" href="/packages/shared-ui/src/glassmorphism.css?dev=${devToken}">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #060b19;
      color: #f8fafc;
      font-family: Inter, system-ui, -apple-system, sans-serif;
    }
    #top-header {
      display: none;
    }
    #app {
      width: 100%;
      height: 100%;
      display: flex;
    }
  </style>
</head>
<body>
  <header id="top-header" class="top-header" aria-label="Application header"></header>
  <main id="app"></main>

  <script type="module">
    // Remove a release PWA worker from this preview origin before importing
    // source modules. This prevents an old precache from masking live edits.
    window.__YAYRA_DEV__ = true;
    const registrations = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    const hadOldWorker = registrations.length > 0 || Boolean(navigator.serviceWorker?.controller);
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if (globalThis.caches) {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    }
    if (hadOldWorker && !sessionStorage.getItem('yayra-dev-worker-cleared')) {
      sessionStorage.setItem('yayra-dev-worker-cleared', '1');
      location.reload();
    } else {
      const { BrowserShell } = await import('/packages/shared-ui/src/components/BrowserShell.js?dev=${devToken}');
      const root = document.getElementById('app');
      const shell = new BrowserShell({ container: root, initialUrl: 'yayra://newtab' });
      await shell.initialize();
      shell.render(root);
    }
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
  res.end(html);
}

server.listen(PORT, HOST, () => {
  console.log(`Yayra FloatBrowse preview server listening on http://${HOST}:${PORT}`);
});
