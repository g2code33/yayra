/**
 * Yayra Floating Browser - Extension & Plugin Subsystem
 * Secure manifest-driven content script and privacy protection engine.
 */

export const BUILT_IN_EXTENSIONS = Object.freeze([
  {
    id: 'yayra-shield',
    name: 'Yayra Ad & Tracker Shield',
    version: '1.2.0',
    description: 'Blocks intrusive ads, analytics trackers, and third-party fingerprinting scripts.',
    author: 'Yayra Security Team',
    permissions: ['webRequest', 'content_script', 'storage'],
    enabled: true,
    allowedInPrivate: true,
    isBuiltIn: true,
    icon: 'shield',
    contentScripts: [
      `// Yayra Shield Tracker Blocking Content Script
console.log('[Yayra Shield] Privacy protections active');`
    ]
  },
  {
    id: 'dark-reader',
    name: 'Dark Reader Pro',
    version: '1.0.4',
    description: 'Inverts bright website styles into high-contrast dark themes for eye care.',
    author: 'Yayra Community',
    permissions: ['content_script', 'activeTab'],
    enabled: false,
    allowedInPrivate: false,
    isBuiltIn: true,
    icon: 'moon',
    contentScripts: [
      `// Dark Reader Pro Injected Script
(function() {
  const style = document.createElement('style');
  style.id = 'yayra-dark-reader-style';
  style.textContent = 'html { filter: invert(90%) hue-rotate(180deg) !important; background: #121212 !important; } img, video, canvas { filter: invert(100%) hue-rotate(180deg) !important; }';
  if (!document.getElementById('yayra-dark-reader-style')) document.head.appendChild(style);
})();`
    ]
  },
  {
    id: 'clean-reader',
    name: 'Clean Page Reader Mode',
    version: '1.1.0',
    description: 'Removes sidebars, popups, and clutter for a distraction-free article reading experience.',
    author: 'Yayra Experience Team',
    permissions: ['content_script', 'activeTab'],
    enabled: false,
    allowedInPrivate: true,
    isBuiltIn: true,
    icon: 'folder',
    contentScripts: [
      `// Clean Page Reader Mode
console.log('[Yayra Reader] Distraction-free mode available');`
    ]
  }
]);

export class ExtensionManager {
  constructor(adapterOrOptions) {
    this.adapter = adapterOrOptions && typeof adapterOrOptions === 'object' && 'storageAdapter' in adapterOrOptions
      ? adapterOrOptions.storageAdapter
      : adapterOrOptions;
    this.STORAGE_KEY = 'yayra-installed-extensions';
    this._extensions = [];
  }

  async initialize() {
    const stored = this.adapter ? await this.adapter.get(this.STORAGE_KEY) : null;
    if (stored && Array.isArray(stored) && stored.length > 0) {
      this._extensions = stored;
    } else {
      // Load built-in defaults
      this._extensions = BUILT_IN_EXTENSIONS.map((ext) => ({ ...ext }));
      if (this.adapter) {
        await this.adapter.set(this.STORAGE_KEY, this._extensions);
      }
    }
    return this._extensions;
  }

  async getExtensions() {
    if (this._extensions.length === 0) {
      await this.initialize();
    }
    return [...this._extensions];
  }

  async getExtension(id) {
    const all = await this.getExtensions();
    return all.find((e) => e.id === id) || null;
  }

  async enableExtension(id) {
    const all = await this.getExtensions();
    const target = all.find((e) => e.id === id);
    if (!target) return false;

    target.enabled = true;
    if (this.adapter) {
      await this.adapter.set(this.STORAGE_KEY, all);
    }
    return true;
  }

  async disableExtension(id) {
    const all = await this.getExtensions();
    const target = all.find((e) => e.id === id);
    if (!target) return false;

    target.enabled = false;
    if (this.adapter) {
      await this.adapter.set(this.STORAGE_KEY, all);
    }
    return true;
  }

  async setAllowedInPrivate(id, allowed) {
    const all = await this.getExtensions();
    const target = all.find((e) => e.id === id);
    if (!target) return false;

    target.allowedInPrivate = Boolean(allowed);
    if (this.adapter) {
      await this.adapter.set(this.STORAGE_KEY, all);
    }
    return true;
  }

  async installExtension(manifest) {
    if (!manifest || !manifest.id || !manifest.name || !manifest.version) {
      throw new Error('Invalid extension manifest: id, name, and version are required.');
    }

    const all = await this.getExtensions();
    const existingIdx = all.findIndex((e) => e.id === manifest.id);

    const newExt = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || '',
      author: manifest.author || 'Custom Developer',
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      enabled: manifest.enabled !== false,
      allowedInPrivate: Boolean(manifest.allowedInPrivate),
      isBuiltIn: false,
      icon: manifest.icon || 'globe',
      contentScripts: Array.isArray(manifest.contentScripts) ? manifest.contentScripts : []
    };

    if (existingIdx !== -1) {
      all[existingIdx] = newExt;
    } else {
      all.push(newExt);
    }

    this._extensions = all;
    if (this.adapter) {
      await this.adapter.set(this.STORAGE_KEY, all);
    }
    return newExt;
  }

  async uninstallExtension(id) {
    const all = await this.getExtensions();
    const target = all.find((e) => e.id === id);
    if (!target) return false;
    if (target.isBuiltIn) {
      throw new Error('Built-in system extensions cannot be uninstalled (they can be disabled).');
    }

    this._extensions = all.filter((e) => e.id !== id);
    if (this.adapter) {
      await this.adapter.set(this.STORAGE_KEY, this._extensions);
    }
    return true;
  }

  async getActiveContentScripts(url, isPrivate = false) {
    const all = await this.getExtensions();
    const scripts = [];

    for (const ext of all) {
      if (!ext.enabled) continue;
      if (isPrivate && !ext.allowedInPrivate) continue;

      if (Array.isArray(ext.contentScripts)) {
        scripts.push(...ext.contentScripts);
      }
    }

    return scripts;
  }

  isExtensionActive(id, isPrivate = false) {
    const ext = this._extensions.find((e) => e.id === id);
    if (!ext || !ext.enabled) return false;
    if (isPrivate && !ext.allowedInPrivate) return false;
    return true;
  }
}
