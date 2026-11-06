/**
 * Yayra Floating Browser - Hardened Website Permission Manager (JS runtime)
 */

export class DefaultNativePermissionProvider {
  async hasSystemPermission(permission) {
    return true;
  }

  async requestSystemPermission(permission) {
    return true;
  }
}

export class WebsitePermissionManager {
  constructor(nativeProvider = new DefaultNativePermissionProvider()) {
    this.permissions = new Map();
    this.listeners = new Map();
    this.nativeProvider = nativeProvider;
  }

  normalizeOrigin(rawOrigin) {
    if (!rawOrigin || typeof rawOrigin !== 'string') {
      throw new Error('Invalid origin provided');
    }

    try {
      const url = new URL(rawOrigin.trim());
      return url.origin;
    } catch {
      if (/^[a-zA-Z0-9.-]+(:\d+)?$/.test(rawOrigin.trim())) {
        return `https://${rawOrigin.trim()}`;
      }
      throw new Error(`Cannot parse invalid origin: ${rawOrigin}`);
    }
  }

  makeKey(origin, permission) {
    return `${this.normalizeOrigin(origin)}:::${permission}`;
  }

  async getPermission(origin, permission) {
    const key = this.makeKey(origin, permission);
    const entry = this.permissions.get(key);

    if (!entry) {
      return 'prompt';
    }

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.permissions.delete(key);
      return 'prompt';
    }

    return entry.state;
  }

  async setPermission(origin, permission, state, ttlMs) {
    const normOrigin = this.normalizeOrigin(origin);
    const key = this.makeKey(normOrigin, permission);

    const record = {
      origin: normOrigin,
      permission,
      state,
      grantedAt: state === 'granted' ? Date.now() : undefined,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined
    };

    this.permissions.set(key, record);
    this.emit('permission:changed', record);
  }

  async requestPermission(origin, permission) {
    const normOrigin = this.normalizeOrigin(origin);
    const currentState = await this.getPermission(normOrigin, permission);

    if (currentState === 'granted' || currentState === 'denied') {
      return currentState;
    }

    return new Promise(async (resolve) => {
      let resolved = false;

      const respond = async (decision) => {
        if (!resolved) {
          resolved = true;
          if (decision === 'granted') {
            const nativeGranted = await this.nativeProvider.requestSystemPermission(permission);
            if (!nativeGranted) {
              await this.setPermission(normOrigin, permission, 'denied');
              resolve('denied');
              return;
            }
          }
          await this.setPermission(normOrigin, permission, decision);
          resolve(decision);
        }
      };

      const event = {
        requestId: `perm_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`,
        origin: normOrigin,
        permission,
        respond
      };

      const cbs = this.listeners.get('permission:requested');
      if (cbs && cbs.size > 0) {
        this.emit('permission:requested', event);
      } else {
        resolve('denied');
      }
    });
  }

  async getAllPermissions() {
    const now = Date.now();
    const result = [];
    for (const [key, val] of this.permissions.entries()) {
      if (val.expiresAt && val.expiresAt < now) {
        this.permissions.delete(key);
      } else {
        result.push(val);
      }
    }
    return result;
  }

  async clearPermissions(origin) {
    if (origin) {
      const normOrigin = this.normalizeOrigin(origin);
      for (const [key, val] of this.permissions.entries()) {
        if (val.origin === normOrigin) {
          this.permissions.delete(key);
        }
      }
    } else {
      this.permissions.clear();
    }
  }

  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  emit(event, ...args) {
    const cbs = this.listeners.get(event);
    if (cbs) {
      cbs.forEach((cb) => {
        try {
          cb(...args);
        } catch {
          // suppress
        }
      });
    }
  }
}
