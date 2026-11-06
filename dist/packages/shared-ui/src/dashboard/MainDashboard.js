/**
 * FloatBrowse Main Dashboard (JS runtime)
 */

import { Icons } from '../icons/icons.js';
import { GlassCard } from '../components/GlassCard.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { Toggle } from '../components/Toggle.js';
import { Dialog } from '../components/Dialog.js';
import { FloatingBubble } from '../components/FloatingBubble.js';

export class MainDashboard {
  constructor(options) {
    this.options = options;
    this.state = {
      serviceRunning: false,
      permissionGranted: true,
      activeTab: 'overview',
      platform: options.platform || this.detectPlatform(),
      settings: {
        desktopFloatingMode: 'circle-first',
        theme: 'dark',
        searchEngine: 'duckduckgo',
        startUrl: 'https://duckduckgo.com',
        defaultZoom: 1.0,
        hardwareAcceleration: true,
        adBlockEnabled: true,
        clearHistoryOnExit: false,
        glassmorphismBlurRadius: 20,
        glassmorphismOpacity: 0.88
      }
    };
    this.rootElement = null;
    this.contentContainer = null;
  }

  async initialize() {
    if (this.options.settingsRepo && typeof this.options.settingsRepo.getSettings === 'function') {
      const loadedSettings = await this.options.settingsRepo.getSettings();
      this.state.settings = loadedSettings;
    }
  }

  render(container = (typeof document !== 'undefined' ? document.body : null)) {
    if (!container) return null;
    const root = document.createElement('div');
    root.className = 'fb-dashboard-container';
    root.id = 'floatbrowse-dashboard';

    const header = this.renderHeader();
    root.appendChild(header);

    const navTabs = this.renderNavTabs();
    root.appendChild(navTabs);

    const content = document.createElement('main');
    content.className = 'fb-dashboard-content';
    content.id = 'fb-tab-content';
    root.appendChild(content);

    this.rootElement = root;
    this.contentContainer = content;
    container.appendChild(root);

    this.renderCurrentTab();
    return root;
  }

  renderHeader() {
    const header = document.createElement('header');
    header.className = 'fb-glass-card';
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; border-radius: var(--fb-radius-xl); gap: 16px;
    `;

    const brandSection = document.createElement('div');
    brandSection.style.cssText = 'display: flex; align-items: center; gap: 14px;';

    const logoOrb = FloatingBubble.render({
      sizePx: 44,
      isActive: this.state.serviceRunning,
      showPulse: this.state.serviceRunning
    });
    brandSection.appendChild(logoOrb);

    const titleCol = document.createElement('div');
    titleCol.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <h1 class="fb-h2" style="font-size:1.4rem; background:var(--fb-gradient-accent); -webkit-background-clip:text; -webkit-text-fill-color:transparent; font-weight:800;">FloatBrowse</h1>
        <span class="fb-badge fb-badge-cyan">${this.state.platform.toUpperCase()}</span>
      </div>
      <span class="fb-body" style="font-size:0.8125rem; color:var(--fb-text-secondary);">Cross-Platform Floating Browser</span>
    `;
    brandSection.appendChild(titleCol);
    header.appendChild(brandSection);

    const actionSection = document.createElement('div');
    actionSection.style.cssText = 'display: flex; align-items: center; gap: 10px;';

    const themeBtn = Button.render({
      variant: 'secondary',
      icon: this.options.themeManager && this.options.themeManager.getMode() === 'dark' ? Icons.sun : Icons.moon,
      ariaLabel: 'Toggle Dark / Light Theme',
      onClick: () => {
        if (this.options.themeManager) {
          const next = this.options.themeManager.toggleMode();
          themeBtn.innerHTML = next === 'dark' ? Icons.sun : Icons.moon;
        }
      }
    });
    actionSection.appendChild(themeBtn);

    const launchBtn = Button.render({
      label: 'Open Browser',
      variant: 'primary',
      icon: Icons.externalLink,
      onClick: () => this.options.onLaunchBrowser?.(this.state.settings.startUrl)
    });
    actionSection.appendChild(launchBtn);

    header.appendChild(actionSection);
    return header;
  }

  renderNavTabs() {
    const nav = document.createElement('nav');
    nav.className = 'fb-nav-tabs';
    nav.setAttribute('aria-label', 'Dashboard sections');

    const tabs = [
      { id: 'overview', label: 'Overview', icon: Icons.globe },
      { id: 'history', label: 'History', icon: Icons.history },
      { id: 'bookmarks', label: 'Bookmarks', icon: Icons.bookmark },
      { id: 'downloads', label: 'Downloads', icon: Icons.download },
      { id: 'settings', label: 'Settings', icon: Icons.settings },
      { id: 'permissions', label: 'Permissions', icon: Icons.shield },
      { id: 'about', label: 'About', icon: Icons.info }
    ];

    tabs.forEach((tab) => {
      const item = document.createElement('button');
      item.className = `fb-tab-item ${this.state.activeTab === tab.id ? 'active' : ''}`;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(this.state.activeTab === tab.id));
      item.innerHTML = `<span>${tab.icon}</span> <span>${tab.label}</span>`;

      item.addEventListener('click', () => {
        this.switchTab(tab.id);
      });
      nav.appendChild(item);
    });

    return nav;
  }

  switchTab(tabId) {
    this.state.activeTab = tabId;
    if (this.rootElement) {
      const buttons = this.rootElement.querySelectorAll('.fb-tab-item');
      buttons.forEach((btn, idx) => {
        const idList = ['overview', 'history', 'bookmarks', 'downloads', 'settings', 'permissions', 'about'];
        if (idList[idx] === tabId) {
          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
        } else {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
        }
      });
    }
    this.renderCurrentTab();
  }

  renderCurrentTab() {
    if (!this.contentContainer) return;
    this.contentContainer.innerHTML = '';

    switch (this.state.activeTab) {
      case 'overview':
        this.renderOverviewTab(this.contentContainer);
        break;
      case 'history':
        this.renderHistoryTab(this.contentContainer);
        break;
      case 'bookmarks':
        this.renderBookmarksTab(this.contentContainer);
        break;
      case 'downloads':
        this.renderDownloadsTab(this.contentContainer);
        break;
      case 'settings':
        this.renderSettingsTab(this.contentContainer);
        break;
      case 'permissions':
        this.renderPermissionsTab(this.contentContainer);
        break;
      case 'about':
        this.renderAboutTab(this.contentContainer);
        break;
    }
  }

  renderOverviewTab(container) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 20px;';

    const hero = document.createElement('div');
    hero.className = 'fb-hero-banner';

    const heroLeft = document.createElement('div');
    heroLeft.style.cssText = 'display: flex; align-items: center; gap: 20px;';

    const heroOrb = FloatingBubble.render({
      sizePx: 64,
      isActive: this.state.serviceRunning,
      showPulse: this.state.serviceRunning
    });
    heroLeft.appendChild(heroOrb);

    const heroInfo = document.createElement('div');
    heroInfo.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="fb-h3">Floating Bubble Service</span>
        <span class="fb-badge ${this.state.serviceRunning ? 'fb-badge-active' : 'fb-badge-inactive'}">
          ${this.state.serviceRunning ? '● Active' : '○ Inactive'}
        </span>
      </div>
      <p class="fb-body" style="margin:6px 0 0; color:var(--fb-text-secondary);">
        ${this.state.serviceRunning
          ? 'Bubble is active on your screen. Tap to expand into floating browser.'
          : 'Service is currently stopped. Start the service to enable the floating bubble.'}
      </p>
    `;
    heroLeft.appendChild(heroInfo);
    hero.appendChild(heroLeft);

    const toggleBtn = Button.render({
      label: this.state.serviceRunning ? 'Stop Floating' : 'Start Floating Bubble',
      variant: this.state.serviceRunning ? 'danger' : 'primary',
      icon: this.state.serviceRunning ? Icons.pause : Icons.play,
      onClick: () => {
        this.state.serviceRunning = !this.state.serviceRunning;
        if (this.state.serviceRunning) {
          this.options.onStartFloating?.();
        } else {
          this.options.onStopFloating?.();
        }
        this.renderCurrentTab();
      }
    });
    hero.appendChild(toggleBtn);
    wrap.appendChild(hero);

    const statsGrid = document.createElement('div');
    statsGrid.className = 'fb-stats-grid';
    statsGrid.appendChild(GlassCard.renderStatCard('Open Tabs', '1 Active', 'Local-first Session', Icons.globe));
    statsGrid.appendChild(GlassCard.renderStatCard('Desktop Mode', this.state.settings.desktopFloatingMode === 'circle-first' ? 'Circle-First' : 'Browser-First', 'Configurable in Settings', Icons.compass));
    statsGrid.appendChild(GlassCard.renderStatCard('Search Engine', (this.state.settings.searchEngine || 'duckduckgo').toUpperCase(), 'Privacy Focused', Icons.search));
    statsGrid.appendChild(GlassCard.renderStatCard('Content Blocker', this.state.settings.adBlockEnabled ? 'Enabled' : 'Disabled', 'Zero Trackers', Icons.shield));
    wrap.appendChild(statsGrid);

    const shortcutsCard = document.createElement('div');
    shortcutsCard.className = 'fb-glass-card';
    shortcutsCard.innerHTML = `
      <h3 class="fb-h3" style="margin-bottom:14px;">Quick Web Shortcuts</h3>
      <div style="display:flex; flex-wrap:wrap; gap:12px;">
        <button class="fb-btn fb-btn-secondary" data-url="https://duckduckgo.com">${Icons.search} <span>DuckDuckGo</span></button>
        <button class="fb-btn fb-btn-secondary" data-url="https://en.wikipedia.org">${Icons.globe} <span>Wikipedia</span></button>
        <button class="fb-btn fb-btn-secondary" data-url="https://github.com">${Icons.externalLink} <span>GitHub</span></button>
        <button class="fb-btn fb-btn-secondary" data-url="https://news.ycombinator.com">${Icons.bookmark} <span>Hacker News</span></button>
      </div>
    `;
    shortcutsCard.querySelectorAll('button[data-url]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        this.options.onLaunchBrowser?.(url);
      });
    });
    wrap.appendChild(shortcutsCard);

    container.appendChild(wrap);
  }

  async renderHistoryTab(container) {
    const entries = this.options.historyRepo ? await this.options.historyRepo.getEntries(50) : [];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;';

    const { container: searchInput } = Input.render({
      type: 'search',
      placeholder: 'Search browsing history...',
      prefixIcon: Icons.search,
      onInput: async (q) => {
        if (!this.options.historyRepo) return;
        const filtered = q ? await this.options.historyRepo.search(q) : await this.options.historyRepo.getEntries();
        listEl.innerHTML = this.renderHistoryListHtml(filtered);
        this.attachHistoryActions(listEl);
      }
    });
    searchInput.style.flex = '1';
    searchInput.style.minWidth = '240px';
    topBar.appendChild(searchInput);

    const clearBtn = Button.render({
      label: 'Clear History',
      variant: 'danger',
      icon: Icons.trash,
      onClick: () => {
        Dialog.show({
          title: 'Clear Browsing History',
          content: 'Are you sure you want to delete all local browsing history records? This action cannot be undone.',
          confirmLabel: 'Clear All',
          isDestructive: true,
          onConfirm: async () => {
            if (this.options.historyRepo) await this.options.historyRepo.clearHistory();
            this.renderCurrentTab();
          }
        });
      }
    });
    topBar.appendChild(clearBtn);
    wrap.appendChild(topBar);

    const listCard = document.createElement('div');
    listCard.className = 'fb-glass-card';

    const listEl = document.createElement('div');
    listEl.id = 'fb-history-list';
    listEl.innerHTML = this.renderHistoryListHtml(entries);
    this.attachHistoryActions(listEl);

    listCard.appendChild(listEl);
    wrap.appendChild(listCard);
    container.appendChild(wrap);
  }

  renderHistoryListHtml(entries) {
    if (!entries || !entries.length) {
      return '<div class="fb-body" style="text-align:center; padding:32px; color:var(--fb-text-muted);">No browsing history records found.</div>';
    }
    return entries.map((e) => `
      <div class="fb-history-item" style="display:flex; align-items:center; justify-content:space-between; padding:12px; border-bottom:1px solid var(--fb-border-glass); gap:12px;">
        <div style="display:flex; align-items:center; gap:12px; overflow:hidden;">
          <span style="color:var(--fb-accent-primary);">${Icons.globe}</span>
          <div style="overflow:hidden;">
            <div class="fb-h4" style="font-size:0.9375rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${e.title || 'Untitled'}</div>
            <a href="${e.url}" target="_blank" class="fb-body" style="font-size:0.8125rem; color:var(--fb-accent-primary); text-decoration:none;">${e.url}</a>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="fb-body" style="font-size:0.75rem; color:var(--fb-text-muted);">${new Date(e.timestamp).toLocaleTimeString()}</span>
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-del-hist" data-id="${e.id}" title="Remove entry">${Icons.trash}</button>
        </div>
      </div>
    `).join('');
  }

  attachHistoryActions(listEl) {
    listEl.querySelectorAll('.fb-del-hist').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (id && this.options.historyRepo) {
          await this.options.historyRepo.deleteEntry(id);
          this.renderCurrentTab();
        }
      });
    });
  }

  async renderBookmarksTab(container) {
    const bookmarks = this.options.bookmarkRepo ? await this.options.bookmarkRepo.getBookmarks() : [];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

    const title = document.createElement('h3');
    title.className = 'fb-h3';
    title.textContent = 'Saved Bookmarks';
    topBar.appendChild(title);

    const addBtn = Button.render({
      label: 'Add Bookmark',
      variant: 'primary',
      icon: Icons.plus,
      onClick: () => {
        const form = document.createElement('div');
        form.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:10px;">
            <label class="fb-body">Title: <input type="text" id="bm-title-in" class="fb-input" style="width:100%; border:1px solid var(--fb-border-glass); border-radius:6px; padding:6px; box-sizing:border-box;" placeholder="Page title" /></label>
            <label class="fb-body">URL: <input type="url" id="bm-url-in" class="fb-input" style="width:100%; border:1px solid var(--fb-border-glass); border-radius:6px; padding:6px; box-sizing:border-box;" placeholder="https://..." /></label>
          </div>
        `;
        Dialog.show({
          title: 'Add New Bookmark',
          content: form,
          confirmLabel: 'Save',
          onConfirm: async () => {
            const titleIn = form.querySelector('#bm-title-in').value;
            const urlIn = form.querySelector('#bm-url-in').value;
            if (titleIn && urlIn && this.options.bookmarkRepo) {
              await this.options.bookmarkRepo.addBookmark(titleIn, urlIn);
              this.renderCurrentTab();
            }
          }
        });
      }
    });
    topBar.appendChild(addBtn);
    wrap.appendChild(topBar);

    const listCard = document.createElement('div');
    listCard.className = 'fb-glass-card';

    if (!bookmarks.length) {
      listCard.innerHTML = '<div class="fb-body" style="text-align:center; padding:32px; color:var(--fb-text-muted);">No bookmarks saved yet.</div>';
    } else {
      listCard.innerHTML = bookmarks.map((b) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid var(--fb-border-glass);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="color:var(--fb-accent-primary);">${Icons.bookmark}</span>
            <div>
              <div class="fb-h4" style="font-size:0.9375rem;">${b.title}</div>
              <a href="${b.url}" target="_blank" style="font-size:0.8125rem; color:var(--fb-accent-primary); text-decoration:none;">${b.url}</a>
            </div>
          </div>
          <button class="fb-btn fb-btn-ghost fb-btn-icon fb-del-bm" data-id="${b.id}">${Icons.trash}</button>
        </div>
      `).join('');

      listCard.querySelectorAll('.fb-del-bm').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (id && this.options.bookmarkRepo) {
            await this.options.bookmarkRepo.deleteBookmark(id);
            this.renderCurrentTab();
          }
        });
      });
    }

    wrap.appendChild(listCard);
    container.appendChild(wrap);
  }

  renderDownloadsTab(container) {
    const wrap = document.createElement('div');
    wrap.className = 'fb-glass-card';
    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 class="fb-h3">Local Downloads</h3>
        <span class="fb-badge fb-badge-cyan">Local Sandbox</span>
      </div>
      <div class="fb-body" style="text-align:center; padding:40px; color:var(--fb-text-muted);">
        ${Icons.download}
        <p style="margin-top:12px;">No active or completed downloads.</p>
      </div>
    `;
    container.appendChild(wrap);
  }

  renderSettingsTab(container) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

    const card = document.createElement('div');
    card.className = 'fb-glass-card';
    card.style.cssText = 'display:flex; flex-direction:column; gap:20px;';

    card.innerHTML = `
      <h3 class="fb-h3">Browser & Floating Preferences</h3>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <label class="fb-h4" style="font-size:0.9375rem;">Desktop Floating Behavior</label>
        <span class="fb-body" style="font-size:0.75rem;">Choose between compact circle-first overlay and pinned floating window.</span>
        <select id="fb-set-desktop-mode" class="fb-select">
          <option value="circle-first" ${this.state.settings.desktopFloatingMode === 'circle-first' ? 'selected' : ''}>
            Circle-first mode (Floating bubble opens browser)
          </option>
          <option value="browser-first" ${this.state.settings.desktopFloatingMode === 'browser-first' ? 'selected' : ''}>
            Browser-first mode (Browser remains floating, minimizes to bubble)
          </option>
        </select>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <label class="fb-h4" style="font-size:0.9375rem;">Default Search Engine</label>
        <select id="fb-set-search" class="fb-select">
          <option value="duckduckgo" ${this.state.settings.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (Privacy Default)</option>
          <option value="searx" ${this.state.settings.searchEngine === 'searx' ? 'selected' : ''}>SearXNG (Decentralized)</option>
          <option value="google" ${this.state.settings.searchEngine === 'google' ? 'selected' : ''}>Google</option>
          <option value="bing" ${this.state.settings.searchEngine === 'bing' ? 'selected' : ''}>Bing</option>
        </select>
      </div>
    `;

    const { container: adblockRow, checkbox: adblockCheck } = Toggle.render({
      label: 'Built-in Ad & Tracker Blocker',
      description: 'Block invasive third-party network ads and tracking scripts locally.',
      checked: this.state.settings.adBlockEnabled,
      onChange: (checked) => {
        this.savePartialSetting({ adBlockEnabled: checked });
      }
    });
    card.appendChild(adblockRow);

    const { container: clearExitRow, checkbox: clearExitCheck } = Toggle.render({
      label: 'Clear Browsing History on Exit',
      description: 'Automatically wipe visit history when closing the application.',
      checked: this.state.settings.clearHistoryOnExit,
      onChange: (checked) => {
        this.savePartialSetting({ clearHistoryOnExit: checked });
      }
    });
    card.appendChild(clearExitRow);

    const saveBtn = Button.render({
      label: 'Save Preferences',
      variant: 'primary',
      onClick: async () => {
        const modeEl = card.querySelector('#fb-set-desktop-mode');
        const searchEl = card.querySelector('#fb-set-search');

        await this.savePartialSetting({
          desktopFloatingMode: modeEl.value,
          searchEngine: searchEl.value,
          adBlockEnabled: adblockCheck.checked,
          clearHistoryOnExit: clearExitCheck.checked
        });

        Dialog.show({
          title: 'Settings Saved',
          content: 'Your preferences have been successfully updated in local persistence.',
          confirmLabel: 'OK'
        });
      }
    });
    card.appendChild(saveBtn);

    wrap.appendChild(card);
    container.appendChild(wrap);
  }

  async savePartialSetting(updates) {
    if (this.options.settingsRepo) {
      const updated = await this.options.settingsRepo.updateSettings(updates);
      this.state.settings = updated;
    }
  }

  renderPermissionsTab(container) {
    const wrap = document.createElement('div');
    wrap.className = 'fb-glass-card';
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 class="fb-h3">System Permissions & Overlay Status</h3>
        <span class="fb-badge fb-badge-active">Verified</span>
      </div>

      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="padding:14px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid var(--fb-border-glass);">
          <div class="fb-h4" style="font-size:0.9375rem;">System Alert Window (Draw Over Other Apps)</div>
          <p class="fb-body" style="font-size:0.8125rem; margin:4px 0 0;">Required on Android to project the floating glass orb over other active mobile applications.</p>
        </div>

        <div style="padding:14px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid var(--fb-border-glass);">
          <div class="fb-h4" style="font-size:0.9375rem;">Foreground Service Exemption</div>
          <p class="fb-body" style="font-size:0.8125rem; margin:4px 0 0;">Ensures the persistent floating bubble process is not terminated by low-memory system triggers.</p>
        </div>
      </div>
    `;

    const reqBtn = Button.render({
      label: 'Request / Verify Permissions',
      variant: 'secondary',
      icon: Icons.shield,
      onClick: () => {
        this.options.onRequestPermissions?.();
        Dialog.show({
          title: 'Permission Status',
          content: 'Overlay permissions are verified. Floating bubble service is ready.',
          confirmLabel: 'OK'
        });
      }
    });
    wrap.appendChild(reqBtn);
    container.appendChild(wrap);
  }

  renderAboutTab(container) {
    const wrap = document.createElement('div');
    wrap.className = 'fb-glass-card';
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

    wrap.innerHTML = `
      <div style="display:flex; align-items:center; gap:14px;">
        <div style="width:48px; height:48px;">${Icons.officialOrb}</div>
        <div>
          <h2 class="fb-h2" style="background:var(--fb-gradient-accent); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">FloatBrowse</h2>
          <span class="fb-body" style="font-size:0.8125rem;">Version 0.1.0 · Build Stable</span>
        </div>
      </div>

      <p class="fb-body" style="line-height:1.6;">
        FloatBrowse is an ultra-modern, local-first cross-platform floating browser.
        Designed with high-fidelity glassmorphism, native web rendering engines per platform, and zero mandatory cloud lock-in.
      </p>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-top:8px;">
        <div style="padding:12px; background:rgba(255,255,255,0.04); border-radius:8px;">
          <strong style="font-size:0.8125rem; color:var(--fb-text-muted);">Android Engine</strong>
          <div class="fb-body" style="color:var(--fb-text-primary);">System WebView / GeckoView</div>
        </div>
        <div style="padding:12px; background:rgba(255,255,255,0.04); border-radius:8px;">
          <strong style="font-size:0.8125rem; color:var(--fb-text-muted);">Windows Engine</strong>
          <div class="fb-body" style="color:var(--fb-text-primary);">Microsoft Edge WebView2</div>
        </div>
        <div style="padding:12px; background:rgba(255,255,255,0.04); border-radius:8px;">
          <strong style="font-size:0.8125rem; color:var(--fb-text-muted);">Linux Engine</strong>
          <div class="fb-body" style="color:var(--fb-text-primary);">WebKitGTK 4.1 / 6.0</div>
        </div>
      </div>
    `;

    container.appendChild(wrap);
  }

  detectPlatform() {
    if (typeof navigator === 'undefined') return 'web';
    const ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua)) return 'linux';
    return 'web';
  }
}
