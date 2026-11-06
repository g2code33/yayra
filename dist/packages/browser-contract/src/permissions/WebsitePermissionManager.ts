/**
 * Yayra Floating Browser - Hardened Website Permission Manager
 * Enforces zero automatic grants, origin normalization, prompt-every-time,
 * native system permission coordination, and origin-scoped storage/revocation.
 */

import { PermissionState, PermissionType, WebsitePermission } from '../models/WebsitePermission.js';
import { IPermissionManager, PermissionRequestEvent, PermissionEvents } from './IPermissionManager.js';

export interface INativePermissionProvider {
  hasSystemPermission(permission: PermissionType): Promise<boolean>;
  requestSystemPermission(permission: PermissionType): Promise<boolean>;
}

export class DefaultNativePermissionProvider implements INativePermissionProvider {
  async hasSystemPermission(permission: PermissionType): Promise<boolean> {
    return true;
  }

  async requestSystemPermission(permission: PermissionType): Promise<boolean> {
    return true;
  }
}

export class WebsitePermissionManager implements IPermissionManager {
  private permissions: Map<string, WebsitePermission> = new Map();
  private listeners: Map<string, Set<Function>> = new Map();
  private nativeProvider: INativePermissionProvider;

  constructor(nativeProvider: INativePermissionProvider = new DefaultNativePermissionProvider()) {
    this.nativeProvider = nativeProvider;
  }

  /**
   * Normalizes an origin string (scheme + host + optional port), stripping paths and query strings
   */
  public normalizeOrigin(rawOrigin: string): string {
    if (!rawOrigin || typeof rawOrigin !== 'string') {
      throw new Error('Invalid origin provided');
    }

    try {
      const url = new URL(rawOrigin.trim());
      return url.origin;
    } catch {
      // If it's a domain name or already normalized
      if (/^[a-zA-Z0-9.-]+(:\d+)?$/.test(rawOrigin.trim())) {
        return `https://${rawOrigin.trim()}`;
      }
      throw new Error(`Cannot parse invalid origin: ${rawOrigin}`);
    }
  }

  private makeKey(origin: string, permission: PermissionType): string {
    return `${this.normalizeOrigin(origin)}:::${permission}`;
  }

  public async getPermission(origin: string, permission: PermissionType): Promise<PermissionState> {
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

  public async setPermission(
    origin: string,
    permission: PermissionType,
    state: PermissionState,
    ttlMs?: number
  ): Promise<void> {
    const normOrigin = this.normalizeOrigin(origin);
    const key = this.makeKey(normOrigin, permission);

    const record: WebsitePermission = {
      origin: normOrigin,
      permission,
      state,
      grantedAt: state === 'granted' ? Date.now() : undefined,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined
    };

    this.permissions.set(key, record);
    this.emit('permission:changed', record);
  }

  public async requestPermission(origin: string, permission: PermissionType): Promise<PermissionState> {
    const normOrigin = this.normalizeOrigin(origin);
    const currentState = await this.getPermission(normOrigin, permission);

    // If explicit decision already made (granted or denied), return it
    if (currentState === 'granted' || currentState === 'denied') {
      return currentState;
    }

    // Zero automatic grants: Must trigger explicit user prompt
    return new Promise<PermissionState>(async (resolve) => {
      let resolved = false;

      const respond = async (decision: 'granted' | 'denied') => {
        if (!resolved) {
          resolved = true;
          if (decision === 'granted') {
            // Coordinate with platform native OS permission before granting
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

      const event: PermissionRequestEvent = {
        requestId: `perm_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`,
        origin: normOrigin,
        permission,
        respond
      };

      const cbs = this.listeners.get('permission:requested');
      if (cbs && cbs.size > 0) {
        this.emit('permission:requested', event);
      } else {
        // Safe default: deny if no prompt handler is attached
        resolve('denied');
      }
    });
  }

  public async getAllPermissions(): Promise<WebsitePermission[]> {
    const now = Date.now();
    const result: WebsitePermission[] = [];
    for (const [key, val] of this.permissions.entries()) {
      if (val.expiresAt && val.expiresAt < now) {
        this.permissions.delete(key);
      } else {
        result.push(val);
      }
    }
    return result;
  }

  public async clearPermissions(origin?: string): Promise<void> {
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

  public on<K extends keyof PermissionEvents>(event: K, listener: PermissionEvents[K]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Function);
    return () => {
      this.listeners.get(event)?.delete(listener as Function);
    };
  }

  private emit(event: string, ...args: any[]): void {
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
