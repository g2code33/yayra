import { applyAdminUpdateConfig, DEFAULT_UPDATE_CONFIG, validateUpdateConfig } from '../config/updates.js';

export function mountAdminUpdatesPanel({ root, config = DEFAULT_UPDATE_CONFIG, latest = {}, audit = [] }) {
  const section = document.createElement('section');
  section.id = 'settings-updates';
  section.innerHTML = `
    <h2>Settings → Updates</h2>
    <form id="updates-admin-form">
      <label>Header control <input name="headerControl" value="persistent" readonly aria-readonly="true" data-locked="true"></label>
      <label>Mobile cadence
        <select name="mobileCadence">
          <option value="per-open">per-open</option>
          <option value="once-a-day">once-a-day</option>
          <option value="off">off</option>
        </select>
      </label>
      <label><input type="checkbox" name="autoDownload"> Desktop auto-download</label>
      <label><input type="checkbox" name="autoInstall"> Desktop auto-install</label>
      <label><input type="checkbox" name="confirmAutomation"> I understand auto-download/auto-install tradeoffs</label>
      <label>Rollout percent <input name="rolloutPercent" type="number" min="0" max="100"></label>
      <label>Release notes <textarea name="notes" maxlength="2000"></textarea></label>
      <button type="submit">Save updates config</button>
      <output id="updates-admin-errors" aria-live="polite"></output>
    </form>
    <div class="tabs">
      <h3>Preview</h3>
      <div id="updates-preview">
        <button class="update-button has-update" aria-label="available; last check preview; version 0.1.0 → 0.2.0">Update available 0.2.0</button>
        <section class="mobile-update-sheet preview" role="dialog" aria-labelledby="preview-update-title"><h4 id="preview-update-title">Mobile sheet preview</h4><p>${escapeHtml(config.notes?.en || '')}</p><p>Includes force and offline variants in the controls below.</p><button>Update now</button><button>Later</button></section>
      </div>
      <h3>Rollout audit</h3>
      <pre id="rollout-audit">${escapeHtml(JSON.stringify(audit, null, 2))}</pre>
    </div>`;
  root.append(section);
  const form = section.querySelector('form');
  form.mobileCadence.value = config.mobile?.promptCadence || 'per-open';
  form.autoDownload.checked = config.desktop?.autoDownload === true;
  form.autoInstall.checked = config.desktop?.autoInstall === true;
  form.rolloutPercent.value = String(config.rollout?.percent ?? 100);
  form.notes.value = config.notes?.en || '';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = JSON.parse(JSON.stringify(config));
    next.desktop.headerControl = form.headerControl.value;
    next.mobile.promptCadence = form.mobileCadence.value;
    next.desktop.autoDownload = form.autoDownload.checked;
    next.desktop.autoInstall = form.autoInstall.checked;
    next.rollout.percent = Number(form.rolloutPercent.value);
    next.notes.en = form.notes.value;
    try {
      const result = applyAdminUpdateConfig(config, next, {
        latest,
        actor: 'local-admin-preview',
        confirmedAutomationTradeoffs: form.confirmAutomation.checked,
        auditLog: audit
      });
      form.querySelector('output').textContent = 'Config valid. Server-side save would accept this payload.';
      section.querySelector('#rollout-audit').textContent = JSON.stringify(result.audit, null, 2);
    } catch (error) {
      form.querySelector('output').textContent = error.message;
    }
  });
  const initial = validateUpdateConfig(config, { latest, confirmedAutomationTradeoffs: true });
  if (!initial.ok) section.querySelector('output').textContent = initial.errors.join('; ');
  return section;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
