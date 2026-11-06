/**
 * WebsitePermission Model
 * Models origin-based security permissions for web APIs (geolocation, camera, microphone, notifications, etc.)
 */

export type PermissionType =
  | 'geolocation'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'midi'
  | 'sensors';

export type PermissionState = 'prompt' | 'granted' | 'denied';

export interface WebsitePermission {
  origin: string;
  permission: PermissionType;
  state: PermissionState;
  grantedAt?: number;
  expiresAt?: number;
}

export function createWebsitePermission(
  origin: string,
  permission: PermissionType,
  state: PermissionState = 'prompt'
): WebsitePermission {
  return {
    origin,
    permission,
    state,
    grantedAt: state === 'granted' ? Date.now() : undefined
  };
}
