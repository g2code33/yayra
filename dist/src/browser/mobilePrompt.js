export function mountMobileUpdatePrompt({ root, promptSession, service, config }) {
  let shownVersion = null;
  service.subscribe((state) => {
    if (!promptSession.shouldPrompt(state, config)) return;
    shownVersion = state.version;
    root.append(renderSheet({ state, service, promptSession, force: state.force === true }));
  });
  return { get shownVersion() { return shownVersion; } };
}

function renderSheet({ state, service, promptSession, force }) {
  const sheet = document.createElement('section');
  sheet.className = 'mobile-update-sheet';
  sheet.role = 'dialog';
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'mobile-update-title');
  sheet.tabIndex = -1;
  const notes = state.manifest?.notes?.en || 'A new version is available.';
  const size = state.download?.bytes ? `${Math.ceil(state.download.bytes / 1024 / 1024)} MB` : 'size unavailable';
  sheet.innerHTML = `
    <div class="sheet-card">
      <h2 id="mobile-update-title">Update yayra to ${escapeHtml(state.version)}</h2>
      <p>${escapeHtml(size)} · ${escapeHtml(state.manifest?.publishedAt || 'date unavailable')}</p>
      <article>${escapeHtml(notes).slice(0, 2000)}</article>
      <div class="sheet-actions"></div>
    </div>`;
  const actions = sheet.querySelector('.sheet-actions');
  const update = button('Update now', async () => {
    if (state.download?.url) location.href = state.download.url;
  });
  actions.append(update);
  if (!force) {
    actions.append(button('×', () => dismiss(sheet, promptSession, state.version, 'session')));
    actions.append(button('Later', () => dismiss(sheet, promptSession, state.version, 'session')));
    actions.append(button('Remind me tomorrow', () => dismiss(sheet, promptSession, state.version, '1d')));
    actions.append(button('Remind me in a week', () => dismiss(sheet, promptSession, state.version, '7d')));
    actions.append(button('Not for this version', () => dismiss(sheet, promptSession, state.version, 'never-for-version')));
  } else {
    actions.append(button('Update to continue', () => service.download()));
    const offline = document.createElement('p');
    offline.className = 'offline-escape';
    offline.textContent = 'If you are offline, you may keep using cached read-only areas until connectivity returns.';
    actions.append(offline);
  }
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !force) dismiss(sheet, promptSession, state.version, 'session');
    if (event.key === 'Tab') trapFocus(sheet, event);
  });
  sheet.focus();
  return sheet;
}

function dismiss(sheet, promptSession, version, scope) {
  promptSession.dismiss(version, scope);
  sheet.remove();
}

function button(label, handler) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', handler);
  return element;
}

function trapFocus(root, event) {
  const focusable = [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
