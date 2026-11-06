/**
 * BrowserLoadingState Model
 * Explicit state model for tracking webview load lifecycles, progress, and errors.
 */

export type LoadingStatus = 'idle' | 'loading' | 'committed' | 'loaded' | 'failed' | 'cancelled';

export interface NavigationError {
  code: number;
  description: string;
  failingUrl: string;
  isCertError?: boolean;
  timestamp: number;
}

export interface BrowserLoadingState {
  status: LoadingStatus;
  progress: number; // 0 to 100
  httpStatusCode?: number;
  error?: NavigationError | null;
  loadedAt?: number;
}

export function createInitialLoadingState(): BrowserLoadingState {
  return {
    status: 'idle',
    progress: 0,
    httpStatusCode: undefined,
    error: null,
    loadedAt: undefined
  };
}
