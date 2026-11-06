/**
 * BrowserLoadingState Model (JS runtime)
 */

export function createInitialLoadingState() {
  return {
    status: 'idle',
    progress: 0,
    httpStatusCode: undefined,
    error: null,
    loadedAt: undefined
  };
}
