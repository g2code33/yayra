/**
 * WebsitePermission Model (JS runtime)
 */

export function createWebsitePermission(origin, permission, state = 'prompt') {
  return {
    origin,
    permission,
    state,
    grantedAt: state === 'granted' ? Date.now() : undefined
  };
}
