/**
 * FloatBrowse Component - BrowserToolbar (JS runtime)
 */

import { Icons } from '../icons/icons.js';

export class BrowserToolbar {
  static render(options = {}) {
    const toolbar = document.createElement('div');
    toolbar.className = 'fb-glass-surface fb-toolbar fb-browser-toolbar';
    toolbar.style.cssText = `
      display: flex; flex-direction: column; gap: 6px; padding: 8px 12px;
      border-radius: var(--fb-radius-lg); width: 100%; box-sizing: border-box;
    `;

    const effectiveUrl = options.currentUrl || options.url || '';

    let tabStripHtml = '';
    if (options.tabs && options.tabs.length > 0) {
      tabStripHtml = `
        <div class="fb-tab-strip" style="display:flex; align-items:center; gap:6px; overflow-x:auto; padding-bottom:4px;">
          ${options.tabs.map((t) => `
            <div class="fb-tab-pill ${t.active ? 'active' : ''}" data-tab-id="${t.id}" style="display:flex; align-items:center; gap:6px; padding:4px 10px; border-radius:6px; background:${t.active ? 'rgba(6,182,212,0.2)' : 'rgba(255,255,255,0.05)'}; cursor:pointer; font-size:0.75rem; border:1px solid ${t.active ? 'rgba(6,182,212,0.4)' : 'rgba(255,255,255,0.08)'};">
              <span style="max-width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.title || 'New Tab'}</span>
              <button class="fb-tab-close" data-close-id="${t.id}" style="background:none; border:none; color:inherit; cursor:pointer; padding:0; display:flex;">×</button>
            </div>
          `).join('')}
          <button class="fb-new-tab-btn fb-btn fb-btn-ghost fb-btn-icon" style="width:24px; height:24px; font-size:14px;">+</button>
        </div>
      `;
    }

    toolbar.innerHTML = `
      ${tabStripHtml}
      <div style="display:flex; align-items:center; gap:8px; width:100%;">
        <div style="display:flex; align-items:center; gap:4px;">
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-nav-back" title="Go back (Alt+Left)" aria-label="Back" ${options.canGoBack ? '' : 'disabled'}>
            ${Icons.arrowLeft}
          </button>
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-nav-forward" title="Go forward (Alt+Right)" aria-label="Forward" ${options.canGoForward ? '' : 'disabled'}>
            ${Icons.arrowRight}
          </button>
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-nav-reload" title="Reload (Ctrl+R)" aria-label="Reload">
            ${Icons.refresh}
          </button>
        </div>

        <div class="fb-input-wrapper" style="flex:1; height:36px; padding:0 10px;">
          <span class="fb-ssl-badge" title="${options.isSecure !== false ? 'Connection is secure (HTTPS)' : 'Insecure connection'}" style="color:${options.isSecure !== false ? '#34d399' : '#f59e0b'}; display:flex; align-items:center;">
            ${options.isSecure !== false ? Icons.lock : Icons.alertTriangle}
          </span>
          <input type="text" class="fb-input fb-url-input" value="${effectiveUrl}" placeholder="Search with DuckDuckGo or enter address" style="font-size:0.875rem;" />
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-bookmark-btn" title="Bookmark this page" aria-label="Bookmark" style="width:28px; height:28px; color:${options.isBookmarked ? 'var(--fb-accent-primary)' : 'var(--fb-text-muted)'};">
            ${Icons.bookmark}
          </button>
        </div>

        <div style="display:flex; align-items:center; gap:6px;">
          <button class="fb-btn fb-btn-secondary fb-mode-btn" title="Current Mode: ${options.desktopMode || 'circle-first'}" style="font-size:0.75rem; padding:6px 10px; height:34px; gap:4px;">
            <span>${options.desktopMode === 'browser-first' ? '🗔 Browser' : '○ Circle'}</span>
          </button>
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-settings-btn" title="Settings" aria-label="Settings">
            ${Icons.settings}
          </button>
        </div>
      </div>
    `;

    const backBtn = toolbar.querySelector('.fb-nav-back');
    const fwdBtn = toolbar.querySelector('.fb-nav-forward');
    const reloadBtn = toolbar.querySelector('.fb-nav-reload');
    const urlInput = toolbar.querySelector('.fb-url-input');
    const bookmarkBtn = toolbar.querySelector('.fb-bookmark-btn');
    const modeBtn = toolbar.querySelector('.fb-mode-btn');
    const settingsBtn = toolbar.querySelector('.fb-settings-btn');

    backBtn?.addEventListener('click', () => options.onGoBack?.());
    fwdBtn?.addEventListener('click', () => options.onGoForward?.());
    reloadBtn?.addEventListener('click', () => options.onReload?.());
    bookmarkBtn?.addEventListener('click', () => options.onBookmarkToggle?.());
    modeBtn?.addEventListener('click', () => options.onToggleMode?.());
    settingsBtn?.addEventListener('click', () => options.onOpenSettings?.());

    urlInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        options.onNavigate?.(urlInput.value);
      }
    });

    toolbar.querySelectorAll?.('.fb-tab-pill')?.forEach((pill) => {
      pill.addEventListener('click', (e) => {
        if (e.target?.classList?.contains('fb-tab-close')) return;
        const tid = pill.dataset.tabId;
        if (tid) options.onTabSelect?.(tid);
      });
    });

    toolbar.querySelectorAll?.('.fb-tab-close')?.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tid = btn.dataset.closeId;
        if (tid) options.onTabClose?.(tid);
      });
    });

    toolbar.querySelector?.('.fb-new-tab-btn')?.addEventListener('click', () => {
      options.onNewTab?.();
    });

    const update = (opt) => {
      const u = opt.currentUrl || opt.url;
      if (u !== undefined && urlInput) urlInput.value = u;
      if (opt.canGoBack !== undefined && backBtn) backBtn.disabled = !opt.canGoBack;
      if (opt.canGoForward !== undefined && fwdBtn) fwdBtn.disabled = !opt.canGoForward;
      if (opt.isBookmarked !== undefined && bookmarkBtn) {
        bookmarkBtn.style.color = opt.isBookmarked ? 'var(--fb-accent-primary)' : 'var(--fb-text-muted)';
      }
      if (opt.desktopMode !== undefined && modeBtn) {
        modeBtn.innerHTML = `<span>${opt.desktopMode === 'browser-first' ? '🗔 Browser' : '○ Circle'}</span>`;
        modeBtn.title = `Current Mode: ${opt.desktopMode}`;
      }
    };

    toolbar.container = toolbar;
    toolbar.update = update;
    return toolbar;
  }
}
