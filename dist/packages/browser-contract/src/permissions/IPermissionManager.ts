/**
 * Yayra Floating Browser - Website Permission Manager Contract & Interface
 */

import { PermissionState, PermissionType, WebsitePermission } from '../models/WebsitePermission.js';

export interface PermissionRequestEvent {
  requestId: string;
  origin: string;
  permission: PermissionType;
  respond: (state: 'granted' | 'denied') => void;
}

export interface PermissionEvents {
  'permission:requested': (event: PermissionRequestEvent) => void;
  'permission:changed': (permission: WebsitePermission) => void;
}

export interface IPermissionManager {
  requestPermission(origin: string, permission: PermissionType): Promise<PermissionState>;
  getPermission(origin: string, permission: PermissionType): Promise<PermissionState>;
  setPermission(origin: string, permission: PermissionType, state: PermissionState): Promise<void>;
  getAllPermissions(): Promise<WebsitePermission[]>;
  clearPermissions(origin?: string): Promise<void>;
  on<K extends keyof PermissionEvents>(event: K, listener: PermissionEvents[K]): () => void;
}
