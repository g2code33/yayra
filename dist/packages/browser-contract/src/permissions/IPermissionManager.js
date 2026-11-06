/**
 * Yayra Floating Browser - Website Permission Manager (JS runtime)
 */

export class BasePermissionManager {
  constructor() {
    this.permissions = new Map(); // key: `${origin}:${permission}`
    this.listeners = new Map();
  }

  async requestPermission(origin, permission) {
    const key = `${origin}:${permission}`;
    const existing = this.permissions.get(key);
    if (existing && existing.state !== 'prompt') {
      return existing.state;
    }

    // Default policy: if in prompt state, dispatch permission:requested event
    return new Promise((resolve) => {
      let resolved = false;
      const respond = (decision) => {
        if (!resolved) {
          resolved = true;
          this.setPermission(origin, permission, decision);
          resolve(decision);
        }
      };

      const event = {
        requestId: `perm_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`,
        origin,
        permission,
        respond
      };

      const cbs = this.listeners.get('permission:requested');
      if (cbs && cbs.size > 0) {
        this.emit('permission:requested', event);
      } else {
        // Safe default if no UI prompt listener attached: prompt remains or denied
        resolve('denied');
      }
    });
  }

  async getPermission(origin, permission) {
    const key = `${origin}:${permission}`;
    const entry = this.permissions.get(key);
    return entry ? entry.state : 'prompt';
  }

  async setPermission(origin, permission, state) {
    const key = `${origin}:${permission}`;
    const record = {
      origin,
      permission,
      state,
      grantedAt: state === 'granted' ? Date.now() : undefined
    };
    this.permissions.set(key, record);
    this.emit('permission:changed', record);
  }

  async getAllPermissions() {
    return Array.from(this.permissions.values());
  }

  async clearPermissions(origin) {
    if (origin) {
      for (const [key, val] of this.permissions.entries()) {
        if (val.origin === origin) {
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
          // Ignore error
        }
      });
    }
  }
}
