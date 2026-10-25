// Yayra autofill preload - injected into every page-rendering
// WebContentsView (sandboxed, contextIsolation on, zero node access for
// the page). Gives Yayra the same two abilities Chrome's built-in
// password manager has on real websites:
//
//   1. CAPTURE: detect login submissions and completed email forms; route
//      passwords to the vault prompt and email addresses to this profile's
//      local-only email suggestions.
//   2. FILL: receive saved credentials and email suggestions from the shell.
//      Passwords fill only on explicit autofill; email addresses appear in a
//      browser-owned picker when an email field is focused.
//
// No privileged Electron API is exposed to the page. The document-start
// WebAuthn observer publishes bounded lifecycle metadata only; its native-call
// control requires a random capability supplied only by the isolated preload.

const { ipcRenderer, contextBridge } = require('electron');

// Google auth-surface parity: Yayra must not insert ANY script or DOM into
// accounts.google.com / consent.google.com / myaccount.google.com. Google's
// secure-browser policy explicitly names "insert custom scripts" and "access
// session cookies" as disqualifying embedded-user-agent capabilities, and its
// risk engine can detect main-world injections and injected DOM nodes.
//
// This guard is evaluated at document start in the isolated preload, before
// any executeInMainWorld call. On an auth surface the whole enhancement layer
// is skipped: native Chromium WebAuthn/passkeys, autofill and form handling
// run exactly as they would in a standalone browser. No automation flag is
// set and nothing is reported to Google.
const GOOGLE_AUTH_SURFACE_HOST = (() => {
  try {
    const host = String((typeof location !== 'undefined' && location && location.hostname) || '').toLowerCase();
    return /^(?:accounts|consent|myaccount)\.google\.com$/.test(host);
  } catch { return false; }
})();

if (!GOOGLE_AUTH_SURFACE_HOST) {
const CAPTURE_CHANNEL = 'yayra:autofill-captured';
const DETECTED_CHANNEL = 'yayra:autofill-form-detected';
const FILL_CHANNEL = 'yayra:autofill-fill';
const EMAIL_FIELD_FOCUSED_CHANNEL = 'yayra:email-field-focused';
const EMAIL_ADDRESS_CAPTURED_CHANNEL = 'yayra:email-address-captured';
const EMAIL_SUGGESTIONS_CHANNEL = 'yayra:email-suggestions';
const SITE_PASSKEY_REQUEST_CHANNEL = 'yayra:site-passkey-request';
const SITE_PASSKEY_CONTROL_CHANNEL = 'yayra:site-passkey-control';

// Install media recovery in the page's MAIN world at document start, before a
// React/Vue image onError handler can unmount a failed full-screen backdrop.
// The fuller dom-ready compatibility script adds low-contrast verification;
// this early gate owns only the decode retry and broken-backdrop fallback.
if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        try {
          const installKey = '__yayraEarlyMediaCompatibilityV3';
          if (window[installKey]) return;
          const attempts = new WeakMap();

          const jpegCloudinaryUrl = (rawUrl) => {
            let parsed;
            try { parsed = new URL(String(rawUrl || '')); } catch { return rawUrl; }
            const marker = '/image/upload/';
            if (!/^https?:$/.test(parsed.protocol)
                || parsed.hostname.toLowerCase() !== 'res.cloudinary.com'
                || !parsed.pathname.includes(marker)) return rawUrl;
            if (parsed.pathname.split('/').some((part) => /^s--[A-Za-z0-9_-]+--$/.test(part))) return rawUrl;
            const markerIndex = parsed.pathname.indexOf(marker);
            const prefix = parsed.pathname.slice(0, markerIndex + marker.length);
            const delivery = parsed.pathname.slice(markerIndex + marker.length);
            let compatible = delivery.replace(
              /(^|[,/])f_(?:auto(?::[^,/]+)?|webp)(?=,|\/|$)/gi,
              (_match, boundary) => `${boundary}f_jpg`
            );
            if (/\.(?:heic|heif)$/i.test(compatible)) compatible = compatible.replace(/\.(?:heic|heif)$/i, '');
            if (compatible === delivery && /\.(?:heic|heif)$/i.test(delivery)) {
              compatible = `q_auto,f_jpg/${delivery.replace(/\.(?:heic|heif)$/i, '')}`;
            }
            if (compatible === delivery) return rawUrl;
            parsed.pathname = `${prefix}${compatible}`;
            return parsed.toString();
          };

          const siteThemeColor = () => {
            try {
              const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
              const selected = metas.find((meta) => {
                const media = meta.getAttribute('media');
                return !media || !window.matchMedia || window.matchMedia(media).matches;
              }) || metas[0];
              return String(selected?.getAttribute('content') || '').trim();
            } catch { return ''; }
          };
          const safeBackdropThemeColor = () => {
            const color = siteThemeColor();
            const text = String(color || '').trim().toLowerCase();
            let channels = null;
            const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
            if (hex) {
              let raw = hex[1];
              if (raw.length === 3) raw = raw.split('').map((part) => part + part).join('');
              channels = [
                Number.parseInt(raw.slice(0, 2), 16),
                Number.parseInt(raw.slice(2, 4), 16),
                Number.parseInt(raw.slice(4, 6), 16)
              ];
            } else {
              const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
              if (rgb) channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
            }
            if (!channels || channels.some((channel) => !Number.isFinite(channel))) return '';
            const brightness = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 255000;
            const chroma = (Math.max(...channels) - Math.min(...channels)) / 255;
            return brightness <= 0.42 && chroma <= 0.35 ? color : '';
          };
          const coversViewport = (element) => {
            try {
              const rect = element.getBoundingClientRect();
              const width = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
              const height = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
              return width > 0 && height > 0 && rect.width >= width * 0.7 && rect.height >= height * 0.7;
            } catch { return false; }
          };
          const retireFailedBackdrop = (image) => {
            let hints = '';
            try {
              const className = typeof image.className === 'string' ? image.className : image.className?.baseVal || '';
              hints = [className, image.id, image.getAttribute('alt'), image.getAttribute('role')].join(' ').toLowerCase();
            } catch { /* use geometry only */ }
            // Do not promote an ordinary failed image to "backdrop" merely
            // because a distant app-shell ancestor fills the viewport. Broad
            // utilities such as w-full/h-full/object-cover are common on cards.
            const target = image.parentElement;
            const semanticBackdrop = /(?:background|backdrop|wallpaper)/.test(hints);
            let layoutBackdrop = false;
            try {
              const style = window.getComputedStyle(image);
              const positioned = style.position === 'fixed' || style.position === 'absolute';
              layoutBackdrop = coversViewport(target) && (
                /\bhero(?:-|\b)/.test(hints)
                || (positioned && (style.objectFit === 'cover' || style.width === '100%' || style.height === '100%'
                  || /(?:object-cover|inset-0)/.test(hints)))
              );
            } catch { /* semantic/geometry evidence remains available */ }
            const backdrop = coversViewport(image) || semanticBackdrop || layoutBackdrop;
            if (backdrop) {
              const color = safeBackdropThemeColor();
              if (target && color) {
                try { target.style.setProperty('background-color', color, 'important'); } catch { /* detached */ }
              }
            }
            if (!String(image.getAttribute('alt') || '').trim() || backdrop) {
              try {
                image.style.setProperty('visibility', 'hidden', 'important');
                image.setAttribute('data-yayra-media-failed', 'true');
              } catch { /* detached */ }
            }
          };

          window.addEventListener('error', (event) => {
            const image = event?.target;
            if (!image || String(image.tagName || '').toLowerCase() !== 'img') return;
            const source = String(image.currentSrc || image.src || image.getAttribute('src') || '');
            const prior = attempts.get(image);
            if (!prior || (prior.source !== source && prior.retry !== source)) {
              const retry = jpegCloudinaryUrl(source);
              if (retry && retry !== source) {
                attempts.set(image, { source, retry });
                try {
                  image.removeAttribute('srcset');
                  image.removeAttribute('sizes');
                  image.src = retry;
                  event.preventDefault?.();
                  event.stopImmediatePropagation?.();
                  event.stopPropagation?.();
                  return;
                } catch { /* fall through to site-owned fallback */ }
              }
            }
            retireFailedBackdrop(image);
          }, true);

          window.addEventListener('load', (event) => {
            const image = event?.target;
            if (!image || String(image.tagName || '').toLowerCase() !== 'img') return;
            attempts.delete(image);
            if (image.getAttribute('data-yayra-media-failed') === 'true') {
              image.removeAttribute('data-yayra-media-failed');
              image.style.removeProperty('visibility');
            }
          }, true);
          window[installKey] = { version: 3 };
        } catch { /* media compatibility must never affect page startup */ }
      }
    });
  } catch { /* older Electron: dom-ready fallback remains active */ }
}

function createSitePasskeyControlToken() {
  try {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    // Do not install a page-callable release gate without an unguessable
    // capability. Current Electron/Chromium always exposes Web Crypto here;
    // an unusual older host safely falls back to ordinary native WebAuthn.
    return '';
  }
}

const sitePasskeyControlToken = createSitePasskeyControlToken();

// The WebAuthn observer runs in the page's MAIN world because that is where
// sites call navigator.credentials. It posts metadata-only lifecycle events;
// this isolated preload validates and forwards them to Yayra chrome. A site
// can already render arbitrary content in its own tab, so spoofed messages
// are constrained to this sender/origin and rate-limited here. No challenge,
// credential ID, user handle, authenticator data, or signature ever crosses.
const activeSitePasskeyRequests = new Map();
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const payload = event.data;
  if (!payload || payload.source !== 'yayra-site-passkey' || payload.version !== 1) return;
  const phase = payload.phase === 'started' || payload.phase === 'settled' ? payload.phase : null;
  const action = payload.action === 'create' || payload.action === 'get' ? payload.action : null;
  const requestId = typeof payload.requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(payload.requestId)
    ? payload.requestId
    : null;
  const rpId = typeof payload.rpId === 'string' && payload.rpId.length <= 253
    && /^[a-z0-9.-]+$/i.test(payload.rpId)
    ? payload.rpId.toLowerCase()
    : null;
  if (!phase || !action || !requestId || !rpId) return;
  let pageHost = '';
  try { pageHost = String(location.hostname || '').toLowerCase(); } catch { return; }
  if (!pageHost || (rpId !== pageHost && !pageHost.endsWith(`.${rpId}`))) return;

  const attachment = payload.attachment === 'platform' || payload.attachment === 'cross-platform'
    ? payload.attachment
    : 'any';
  let lifecycle = {
    action,
    rpId,
    conditional: Boolean(payload.conditional),
    attachment,
    controlled: payload.controlled === true
  };
  if (phase === 'started') {
    if (activeSitePasskeyRequests.has(requestId) || activeSitePasskeyRequests.size >= 8) return;
    // This map belongs to the document's isolated world and disappears on
    // navigation. Do not age out a real ceremony while Chromium is still
    // waiting: doing so would drop its later settle event and strand chrome.
    activeSitePasskeyRequests.set(requestId, lifecycle);
  } else {
    lifecycle = activeSitePasskeyRequests.get(requestId);
    if (!lifecycle) return;
    activeSitePasskeyRequests.delete(requestId);
  }

  const errorName = typeof payload.errorName === 'string' && /^[A-Za-z]+Error$/.test(payload.errorName)
    ? payload.errorName.slice(0, 64)
    : '';
  try {
    ipcRenderer.send(SITE_PASSKEY_REQUEST_CHANNEL, {
      phase,
      ...lifecycle,
      requestId,
      success: phase === 'settled' ? Boolean(payload.success) : undefined,
      errorName
    });
  } catch { /* view detached during navigation */ }
}, true);

// Install the request observer in the page's MAIN world at document start.
// Waiting for `dom-ready` can miss a site's early conditional WebAuthn call;
// executeInMainWorld runs before page scripts while keeping the preload itself
// isolated. The fuller dom-ready watchdog subscribes to this observer later to
// add guidance/fallback UI without wrapping navigator.credentials twice.
if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
  try {
    contextBridge.executeInMainWorld({
      func: (controlToken) => {
        try {
          if (window.__yayraSitePasskeyObserver?.version === 1) return;
          if (!window.PublicKeyCredential || !navigator.credentials) return;
          const credentials = navigator.credentials;
          const postToWindow = typeof window.postMessage === 'function'
            ? window.postMessage.bind(window)
            : null;
          const subscribers = [];
          const active = new Map();
          const controlled = typeof controlToken === 'string' && /^[a-f0-9]{64}$/.test(controlToken);
          // webContents.send reaches every preload frame. A per-document
          // namespace prevents two same-origin frames from ever sharing an ID
          // and being released by one trusted command.
          const requestNamespace = controlled ? controlToken.slice(0, 16) : '';
          let sequence = 0;

          const relyingPartyId = (options) => {
            let candidate = '';
            try {
              candidate = options?.publicKey?.rpId || options?.publicKey?.rp?.id || window.location?.hostname || '';
            } catch { candidate = ''; }
            candidate = String(candidate || '').trim().toLowerCase();
            if (candidate && candidate.length <= 253 && /^[a-z0-9.-]+$/.test(candidate)) return candidate;
            const fallback = String(window.location?.hostname || '').trim().toLowerCase();
            return fallback && fallback.length <= 253 && /^[a-z0-9.-]+$/.test(fallback) ? fallback : '';
          };
          const publish = (payload) => {
            try { postToWindow?.(payload, '*'); } catch { /* isolated preload remains the source of truth */ }
            for (const subscriber of subscribers.slice()) {
              try { subscriber({ ...payload }); } catch { /* helper UI is best-effort */ }
            }
          };
          const requestMetadata = (action, options) => {
            const selection = options?.publicKey?.authenticatorSelection;
            const attachment = selection?.authenticatorAttachment;
            return {
              source: 'yayra-site-passkey',
              version: 1,
              phase: 'started',
              requestId: `yayra-wa-${Date.now().toString(36)}-${++sequence}${requestNamespace ? `-${requestNamespace}` : ''}`,
              action,
              rpId: relyingPartyId(options),
              conditional: options?.mediation === 'conditional',
              attachment: attachment === 'platform' || attachment === 'cross-platform' ? attachment : 'any',
              controlled
            };
          };
          const abortError = () => {
            try { return new window.DOMException('The passkey request was cancelled.', 'AbortError'); } catch {
              const error = new Error('The passkey request was cancelled.');
              try { error.name = 'AbortError'; } catch { /* Error name is writable in Chromium */ }
              return error;
            }
          };
          const wrap = (name, action) => {
            const original = credentials[name];
            if (typeof original !== 'function') return true;
            const wrapped = function (options) {
              if (!options?.publicKey) return original.apply(credentials, arguments);
              const args = Array.from(arguments);
              const metadata = requestMetadata(action, options);

              // A false virtual touch leaves Chromium's CTAP transaction
              // pending; changing the touch flag later does not replay that
              // command. Keep the native call behind this gate so Yayra can
              // arm verified presence first, then start the exact untouched
              // WebAuthn request. Non-local/native paths are released by main
              // immediately. The random capability prevents page JavaScript
              // from self-approving its own request.
              if (controlled) {
                let resolveOuter;
                let rejectOuter;
                let invoked = false;
                let settled = false;
                let abortSignal = null;
                let abortListener = null;
                let nativeAbortController = null;
                const outer = new Promise((resolve, reject) => {
                  resolveOuter = resolve;
                  rejectOuter = reject;
                });
                const cleanup = () => {
                  active.delete(metadata.requestId);
                  if (abortSignal && abortListener) {
                    try { abortSignal.removeEventListener('abort', abortListener); } catch { /* nonstandard signal */ }
                  }
                };
                const settle = (success, value) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  publish({
                    ...metadata,
                    phase: 'settled',
                    success,
                    errorName: success ? '' : String(value?.name || '')
                  });
                  if (success) resolveOuter(value);
                  else rejectOuter(value);
                };
                const release = () => {
                  if (invoked || settled) return;
                  invoked = true;
                  let nativeResult;
                  let nativeArgs = args;
                  try {
                    // Keep an internal abort handle even after the untouched
                    // request has entered Chromium. Main can therefore end a
                    // released-but-stalled ceremony deterministically; the
                    // site's own signal is forwarded by abortListener below.
                    if (typeof window.AbortController === 'function') {
                      nativeAbortController = new window.AbortController();
                      nativeArgs = args.slice();
                      nativeArgs[0] = { ...options, signal: nativeAbortController.signal };
                    }
                    nativeResult = original.apply(credentials, nativeArgs);
                  } catch (error) {
                    settle(false, error);
                    return;
                  }
                  if (!nativeResult || typeof nativeResult.then !== 'function') {
                    const error = new Error('WebAuthn did not return a promise.');
                    try { error.name = 'InvalidStateError'; } catch { /* best effort */ }
                    settle(false, error);
                    return;
                  }
                  nativeResult.then(
                    (value) => settle(true, value),
                    (error) => settle(false, error)
                  );
                };
                const cancel = (reason) => {
                  if (settled) return;
                  const error = reason || abortError();
                  if (invoked && nativeAbortController) {
                    try { nativeAbortController.abort(error); } catch { /* old AbortController */ }
                  }
                  // Resolve the page-facing promise immediately as cancelled;
                  // the native rejection (if later) is ignored by settle().
                  settle(false, error);
                };
                active.set(metadata.requestId, { metadata, release, cancel });

                try { abortSignal = options?.signal || null; } catch { abortSignal = null; }
                if (abortSignal?.aborted) {
                  cancel(abortSignal.reason || abortError());
                  return outer;
                }
                if (abortSignal && typeof abortSignal.addEventListener === 'function') {
                  abortListener = () => cancel(abortSignal.reason || abortError());
                  try { abortSignal.addEventListener('abort', abortListener, { once: true }); } catch { /* nonstandard signal */ }
                }
                publish(metadata);
                return outer;
              }

              // Fail open only when this old/unusual renderer has no secure
              // random capability. Main marks such requests as non-local, so
              // the software provider can never rely on a late virtual touch.
              publish(metadata);
              let result;
              try {
                result = original.apply(credentials, args);
              } catch (error) {
                publish({ ...metadata, phase: 'settled', success: false, errorName: String(error?.name || '') });
                throw error;
              }
              if (!result || typeof result.then !== 'function') {
                publish({ ...metadata, phase: 'settled', success: false, errorName: 'InvalidStateError' });
                return result;
              }
              const record = { metadata };
              active.set(metadata.requestId, record);
              result.then(
                () => {
                  active.delete(metadata.requestId);
                  publish({ ...metadata, phase: 'settled', success: true, errorName: '' });
                },
                (error) => {
                  active.delete(metadata.requestId);
                  publish({ ...metadata, phase: 'settled', success: false, errorName: String(error?.name || '') });
                }
              );
              return result;
            };
            try {
              Object.defineProperty(credentials, name, { configurable: true, writable: true, value: wrapped });
            } catch {
              try { credentials[name] = wrapped; } catch { /* frozen by the embedder */ }
            }
            return credentials[name] === wrapped;
          };

          const methods = Object.freeze({
            get: wrap('get', 'get'),
            create: wrap('create', 'create')
          });
          const observer = Object.freeze({
            version: 1,
            methods,
            subscribe(listener) {
              if (typeof listener !== 'function') return () => {};
              subscribers.push(listener);
              for (const record of active.values()) {
                try { listener({ ...record.metadata }); } catch { /* subscriber owns its failure */ }
              }
              return () => {
                const index = subscribers.indexOf(listener);
                if (index >= 0) subscribers.splice(index, 1);
              };
            },
            control(message, presentedToken) {
              if (!controlled || presentedToken !== controlToken || !message || typeof message !== 'object') return false;
              const requestId = typeof message.requestId === 'string' ? message.requestId : '';
              if (!/^yayra-wa-[a-z0-9-]{1,80}$/i.test(requestId)) return false;
              const record = active.get(requestId);
              if (!record || typeof record.release !== 'function') return false;
              if (message.command === 'hold') return true;
              if (message.command === 'release') { record.release(); return true; }
              if (message.command === 'cancel') { record.cancel?.(abortError()); return true; }
              return false;
            }
          });
          try {
            Object.defineProperty(window, '__yayraSitePasskeyObserver', {
              configurable: false,
              enumerable: false,
              writable: false,
              value: observer
            });
          } catch { window.__yayraSitePasskeyObserver = observer; }
        } catch { /* Chromium WebAuthn remains untouched if early observation is unavailable */ }
      },
      args: [sitePasskeyControlToken]
    });
  } catch { /* older Electron: the dom-ready watchdog below remains the fallback */ }
}

// Only the isolated preload receives this command from Electron main. It
// crosses into the page world with the per-document random capability that
// was captured by the frozen observer closure above. A website can discover
// the control function, but cannot guess the capability needed to use it.
ipcRenderer.on(SITE_PASSKEY_CONTROL_CHANNEL, (_event, payload = {}) => {
  const requestId = typeof payload.requestId === 'string' && /^yayra-wa-[a-z0-9-]{1,80}$/i.test(payload.requestId)
    ? payload.requestId
    : '';
  const command = payload.command === 'hold' || payload.command === 'release' || payload.command === 'cancel'
    ? payload.command
    : '';
  if (!sitePasskeyControlToken || !requestId || !command
      || !contextBridge || typeof contextBridge.executeInMainWorld !== 'function') return;
  try {
    contextBridge.executeInMainWorld({
      func: (message, controlToken) => {
        try { window.__yayraSitePasskeyObserver?.control?.(message, controlToken); } catch { /* document navigated */ }
      },
      args: [{ requestId, command }, sitePasskeyControlToken]
    });
  } catch { /* document navigated or the renderer is shutting down */ }
});

const USERNAME_SELECTOR = [
  'input[type="email"]',
  'input[type="text"]',
  'input[type="tel"]',
  'input:not([type])'
].join(',');

function isVisible(el) {
  if (!el) return false;
  try {
    const style = window.getComputedStyle?.(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  } catch { /* use the layout bounds below */ }
  const rect = el.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function isEmailAddress(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at >= email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.length <= 64 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..')
    && domain.split('.').every((label) => label && label.length <= 63);
}

function isEmailField(input) {
  if (!input || String(input.tagName || '').toLowerCase() !== 'input' || input.disabled || input.readOnly) return false;
  const type = String(input.type || '').toLowerCase();
  if (type === 'email') return true;
  if (['password', 'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(type)) return false;
  const hints = [
    input.name, input.id, input.placeholder, input.inputMode,
    input.getAttribute?.('autocomplete'), input.getAttribute?.('aria-label')
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:^|[^a-z])e-?mail(?:$|[^a-z])|email[_-]?address/.test(hints);
}

function findUsernameFor(passwordInput) {
  const form = passwordInput.form;
  const scope = form || document;
  const candidates = Array.from(scope.querySelectorAll(USERNAME_SELECTOR))
    .filter((el) => el !== passwordInput && !el.disabled);
  if (candidates.length === 0) return null;
  // Prefer autocomplete hints, then the closest field ABOVE the password.
  const hinted = candidates.find((el) => /username|email/i.test(el.getAttribute('autocomplete') || '')
    || /user|email|login|account|phone/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`));
  if (hinted) return hinted;
  let best = null;
  for (const el of candidates) {
    if (el.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
  }
  return best || candidates[0];
}

function collectCredential(passwordInput) {
  if (!passwordInput || !passwordInput.value) return null;
  // Ignore fields the site marks as new-password confirmations with no value yet
  const usernameInput = findUsernameFor(passwordInput);
  return {
    url: String(location.href || ''),
    username: usernameInput ? String(usernameInput.value || '').trim() : '',
    password: String(passwordInput.value)
  };
}

function activePasswordInput(scope) {
  const inputs = Array.from((scope || document).querySelectorAll('input[type="password"]'))
    .filter((el) => !el.disabled && el.value);
  // Prefer a visible one; hidden fields are usually anti-bot honeypots.
  return inputs.find(isVisible) || inputs[0] || null;
}

let lastSent = null;
function report(credential) {
  if (!credential || !credential.password || !credential.username) return;
  const sig = `${credential.url}|${credential.username}|${credential.password}`;
  if (sig === lastSent) return; // same submission observed twice (submit + click)
  lastSent = sig;
  try { ipcRenderer.send(CAPTURE_CHANNEL, credential); } catch { /* detached */ }
}

const recentEmailReports = new Map();
function reportEmailAddress(value) {
  const email = String(value || '').trim();
  if (!isEmailAddress(email)) return;
  const url = String(location.href || '');
  const key = `${location.origin || url}|${email.toLocaleLowerCase()}`;
  const now = Date.now();
  if (now - (recentEmailReports.get(key) || 0) < 2500) return;
  recentEmailReports.set(key, now);
  if (recentEmailReports.size > 32) recentEmailReports.delete(recentEmailReports.keys().next().value);
  try { ipcRenderer.send(EMAIL_ADDRESS_CAPTURED_CHANNEL, { url, email }); } catch { /* detached */ }
}

function reportEmailInputs(scope) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  for (const input of Array.from(scope.querySelectorAll('input'))) {
    if (!isEmailField(input) || !isVisible(input)) continue;
    reportEmailAddress(input.value);
  }
}

// 1) Classic form submission.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form || !form.querySelectorAll) return;
  reportEmailInputs(form);
  const pwd = activePasswordInput(form);
  if (pwd) report(collectCredential(pwd));
}, true);

// 2) SPA logins that never fire submit: Enter inside a password field or
//    a click on a submit-looking button while a password field is filled.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const target = event.target;
  if (isEmailField(target) && target.form) reportEmailInputs(target.form);
  if (target && target.matches && target.matches('input[type="password"]') && target.value) {
    report(collectCredential(target));
  }
}, true);

document.addEventListener('click', (event) => {
  const btn = event.target && event.target.closest
    ? event.target.closest('button, input[type="submit"], [role="button"]')
    : null;
  if (!btn) return;
  const label = `${btn.textContent || ''} ${btn.value || ''} ${btn.getAttribute?.('aria-label') || ''}`;
  const actionLike = /log\s*in|sign\s*in|sign\s*up|register|continue|submit|next|subscribe|join|create account|send/i.test(label);
  const submitButton = String(btn.type || '').toLowerCase() === 'submit'
    || Boolean(btn.matches && btn.matches('input[type="submit"]'));
  if (!actionLike && !submitButton) return;
  const scope = btn.form || document;
  reportEmailInputs(scope);
  const pwd = activePasswordInput(scope);
  if (pwd) report(collectCredential(pwd));
}, true);

// 3) Tell the shell when a login form exists so it can offer autofill.
function announceFormsIfAny() {
  const pwd = document.querySelector('input[type="password"]');
  if (pwd) {
    try { ipcRenderer.send(DETECTED_CHANNEL, { url: String(location.href || '') }); } catch { /* detached */ }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', announceFormsIfAny);
} else {
  announceFormsIfAny();
}
// SPAs mount login forms late - watch briefly after load as well.
let announceTicks = 0;
const announceTimer = setInterval(() => {
  announceTicks += 1;
  announceFormsIfAny();
  if (announceTicks >= 10) clearInterval(announceTimer);
}, 1500);

// 4) Fill saved credentials on request from the shell.
function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc && desc.set) desc.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Email suggestions are rendered in a CLOSED shadow root. The host page can
// see that a small browser-owned overlay exists, but cannot read saved email
// values or change its contents through page JavaScript.
let savedEmailSuggestions = [];
let focusedEmailField = null;
let emailSuggestionHost = null;
let emailSuggestionRoot = null;
let emailSuggestionList = null;
let visibleEmailSuggestions = [];
let selectedEmailSuggestion = -1;

function ensureEmailSuggestionMenu() {
  if (emailSuggestionHost && emailSuggestionList) return true;
  if (!document.documentElement) return false;
  emailSuggestionHost = document.createElement('div');
  emailSuggestionHost.setAttribute('aria-hidden', 'true');
  emailSuggestionHost.style.cssText = 'position:fixed;display:none;z-index:2147483647;pointer-events:auto;';
  emailSuggestionRoot = emailSuggestionHost.attachShadow({ mode: 'closed' });
  emailSuggestionRoot.innerHTML = `
    <style>
      :host { all: initial; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .menu { box-sizing: border-box; max-height: 240px; overflow: auto; padding: 4px; border: 1px solid rgba(255,255,255,.15); border-radius: 10px; background: #171a22; color: #f5f6fa; box-shadow: 0 10px 32px rgba(0,0,0,.38); }
      .item { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 9px 11px; border-radius: 7px; color: inherit; font: 500 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item:hover, .item[aria-selected="true"] { background: rgba(109,93,242,.24); }
      .item:focus-visible { outline: 2px solid #8b82ff; outline-offset: -2px; }
    </style>
    <div class="menu" role="listbox" aria-label="Saved email addresses"></div>`;
  emailSuggestionList = emailSuggestionRoot.querySelector('.menu');
  document.documentElement.appendChild(emailSuggestionHost);
  return Boolean(emailSuggestionList);
}

function hideEmailSuggestions() {
  if (emailSuggestionHost) {
    emailSuggestionHost.style.display = 'none';
    emailSuggestionHost.setAttribute('aria-hidden', 'true');
  }
  visibleEmailSuggestions = [];
  selectedEmailSuggestion = -1;
}

function positionEmailSuggestions() {
  if (!emailSuggestionHost || emailSuggestionHost.style.display === 'none' || !focusedEmailField) return;
  const rect = focusedEmailField.getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height) { hideEmailSuggestions(); return; }
  const viewportWidth = Math.max(240, Number(window.innerWidth) || 1024);
  const viewportHeight = Math.max(200, Number(window.innerHeight) || 768);
  const width = Math.max(200, Math.min(360, Math.max(rect.width, 240), viewportWidth - 16));
  const measuredHeight = emailSuggestionHost.getBoundingClientRect?.().height || 220;
  const top = rect.bottom + measuredHeight + 8 > viewportHeight && rect.top > measuredHeight
    ? rect.top - measuredHeight - 4
    : rect.bottom + 4;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  emailSuggestionHost.style.width = `${width}px`;
  emailSuggestionHost.style.left = `${left}px`;
  emailSuggestionHost.style.top = `${Math.max(8, top)}px`;
}

function renderEmailSuggestions() {
  if (!focusedEmailField || !isEmailField(focusedEmailField) || !ensureEmailSuggestionMenu()) {
    hideEmailSuggestions();
    return;
  }
  const query = String(focusedEmailField.value || '').trim().toLocaleLowerCase();
  visibleEmailSuggestions = savedEmailSuggestions
    .filter((email) => !query || email.toLocaleLowerCase().startsWith(query))
    .slice(0, 12);
  if (!visibleEmailSuggestions.length) { hideEmailSuggestions(); return; }
  selectedEmailSuggestion = -1;
  emailSuggestionList.textContent = '';
  for (const [index, email] of visibleEmailSuggestions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.textContent = email;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (!focusedEmailField) return;
      setNativeValue(focusedEmailField, email);
      hideEmailSuggestions();
    });
    emailSuggestionList.appendChild(button);
  }
  emailSuggestionHost.style.display = 'block';
  emailSuggestionHost.setAttribute('aria-hidden', 'false');
  positionEmailSuggestions();
}

function chooseEmailSuggestion(index) {
  if (!focusedEmailField || !visibleEmailSuggestions.length) return;
  const chosenIndex = index < 0 ? 0 : Math.min(index, visibleEmailSuggestions.length - 1);
  const email = visibleEmailSuggestions[chosenIndex];
  if (!email) return;
  setNativeValue(focusedEmailField, email);
  hideEmailSuggestions();
}

ipcRenderer.on(EMAIL_SUGGESTIONS_CHANNEL, (_event, payload = {}) => {
  savedEmailSuggestions = (Array.isArray(payload?.emails) ? payload.emails : [])
    .map((value) => String(value || '').trim())
    .filter((email, index, all) => isEmailAddress(email)
      && all.findIndex((item) => item.toLocaleLowerCase() === email.toLocaleLowerCase()) === index)
    .slice(0, 25);
  if (focusedEmailField) renderEmailSuggestions();
  else hideEmailSuggestions();
});

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!isEmailField(target) || !isVisible(target)) return;
  const rect = target.getBoundingClientRect?.();
  const viewportWidth = Number(window.innerWidth) || 1024;
  const viewportHeight = Number(window.innerHeight) || 768;
  if (!rect || rect.right <= 0 || rect.left >= viewportWidth || rect.bottom <= 0 || rect.top >= viewportHeight) return;
  focusedEmailField = target;
  savedEmailSuggestions = [];
  hideEmailSuggestions();
  try { ipcRenderer.send(EMAIL_FIELD_FOCUSED_CHANNEL, { url: String(location.href || '') }); } catch { /* detached */ }
}, true);

document.addEventListener('input', (event) => {
  if (event.target === focusedEmailField) renderEmailSuggestions();
}, true);

document.addEventListener('focusout', (event) => {
  if (event.target !== focusedEmailField) return;
  setTimeout(() => {
    const active = document.activeElement;
    if (active !== focusedEmailField && active !== emailSuggestionHost) {
      focusedEmailField = null;
      hideEmailSuggestions();
    }
  }, 0);
}, true);

document.addEventListener('keydown', (event) => {
  if (!emailSuggestionHost || emailSuggestionHost.style.display === 'none') return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedEmailSuggestion = (selectedEmailSuggestion + 1) % visibleEmailSuggestions.length;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedEmailSuggestion = selectedEmailSuggestion <= 0 ? visibleEmailSuggestions.length - 1 : selectedEmailSuggestion - 1;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseEmailSuggestion(selectedEmailSuggestion);
    return;
  } else if (event.key === 'Escape') {
    hideEmailSuggestions();
    return;
  } else {
    return;
  }
  emailSuggestionList.querySelectorAll('.item').forEach((button, index) => {
    button.setAttribute('aria-selected', String(index === selectedEmailSuggestion));
  });
}, true);

window.addEventListener('scroll', positionEmailSuggestions, true);
window.addEventListener('resize', positionEmailSuggestions, true);

ipcRenderer.on(FILL_CHANNEL, (_event, { username, password } = {}) => {
  try {
    const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
    const pwd = pwdInputs[0] || document.querySelector('input[type="password"]');
    if (!pwd) return;
    if (typeof password === 'string' && password) setNativeValue(pwd, password);
    const userInput = findUsernameFor(pwd);
    if (userInput && typeof username === 'string' && username && !userInput.value) {
      setNativeValue(userInput, username);
    }
  } catch { /* never break the page */ }
});

} // end !GOOGLE_AUTH_SURFACE_HOST: zero page scripts on Google auth surfaces
