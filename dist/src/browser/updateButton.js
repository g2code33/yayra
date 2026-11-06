export function mountUpdateButton({ root, service, config }) {
  const button = document.createElement('button');
  button.id = 'update-button';
  button.className = 'update-button';
  button.type = 'button';
  button.dataset.locked = 'persistent';
  button.setAttribute('aria-live', 'polite');
  button.textContent = 'Updates: idle';
  root.append(button);

  function render(state) {
    const installed = state.installedVersion || service.installedVersion;
    const available = state.version ? ` → ${state.version}` : '';
    const checked = state.checkedAt || state.lastSeenAt || 'never';
    const reason = state.reason ? ` (${state.reason})` : '';
    button.dataset.state = state.status;
    button.classList.toggle('has-update', state.status === 'available' || state.status === 'ready');
    if (state.status === 'disabled') {
      button.textContent = 'Updates disabled';
    } else if (state.status === 'available') {
      button.textContent = `Update available ${state.version}`;
    } else if (state.status === 'ready') {
      button.textContent = `Restart to update ${state.version}`;
    } else {
      button.textContent = `Updates: ${state.status}`;
    }
    button.setAttribute('aria-label', `${state.status}${reason}; last check ${checked}; version ${installed}${available}`);
    button.title = button.getAttribute('aria-label') || '';
  }

  service.subscribe(render);
  button.addEventListener('click', async () => {
    if (service.state.status === 'ready') {
      await service.install();
    } else {
      await service.check({ manual: true });
    }
  });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showUpdateMenu(button, service, config);
  });
  if (config.desktop?.autoCheck) {
    const delay = Math.max(100, Number(config.desktop.startupDelayMs || 1200));
    setTimeout(() => service.check({ manual: false }), delay);
  }
  return button;
}

function showUpdateMenu(button, service, config) {
  let menu = document.getElementById('update-menu');
  if (menu) menu.remove();
  menu = document.createElement('div');
  menu.id = 'update-menu';
  menu.className = 'update-menu';
  menu.role = 'menu';
  const items = [
    ['Check now', () => service.check({ manual: true })],
    [`What's new`, () => showNotes(config.notes?.en || 'No release notes are available yet.')],
    ['Copy diagnostics', async () => navigator.clipboard?.writeText(JSON.stringify(service.diagnostics(), null, 2))],
    ['Remind me later', () => service.dismiss('1d')]
  ];
  for (const [label, handler] of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitem';
    item.textContent = label;
    item.addEventListener('click', async () => { await handler(); menu?.remove(); });
    menu.append(item);
  }
  button.after(menu);
}

function showNotes(markdown) {
  const toast = document.getElementById('toast') || document.createElement('div');
  toast.id = 'toast';
  toast.textContent = markdown.slice(0, 2000);
  document.body.append(toast);
}
