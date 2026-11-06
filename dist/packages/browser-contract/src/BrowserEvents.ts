/**
 * Yayra Floating Browser - Engine Event Types
 */

export interface BrowserEngineEvents {
  onLoadStart: (url: string) => void;
  onLoadCommit: (url: string) => void;
  onLoadFinish: (url: string, httpStatusCode: number) => void;
  onLoadError: (url: string, errorCode: number, errorDescription: string) => void;
  onTitleReceived: (title: string) => void;
  onFaviconReceived: (faviconUrl: string) => void;
  onProgressChange: (progress: number) => void; // 0 to 100
  onNewWindowRequested: (targetUrl: string, userInitiated: boolean) => void;
  onCertificateError: (error: string, certIssuer: string) => void;
  onRenderProcessCrashed: (reason: string, killed: boolean) => void;
}
