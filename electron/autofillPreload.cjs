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
// Nothing here is exposed to the page: no contextBridge API is published,
// listeners run in the isolated preload world only.

const { ipcRenderer } = require('electron');

const CAPTURE_CHANNEL = 'yayra:autofill-captured';
const DETECTED_CHANNEL = 'yayra:autofill-form-detected';
const FILL_CHANNEL = 'yayra:autofill-fill';
const EMAIL_FIELD_FOCUSED_CHANNEL = 'yayra:email-field-focused';
const EMAIL_ADDRESS_CAPTURED_CHANNEL = 'yayra:email-address-captured';
const EMAIL_SUGGESTIONS_CHANNEL = 'yayra:email-suggestions';

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
