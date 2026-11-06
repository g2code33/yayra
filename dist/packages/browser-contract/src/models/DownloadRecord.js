/**
 * DownloadRecord Model (JS runtime)
 */

export function createDownloadRecord(url, filename, savePath, totalBytes = 0, mimeType) {
  return {
    id: `dl_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`,
    url,
    filename,
    mimeType,
    totalBytes,
    receivedBytes: 0,
    state: 'pending',
    startTime: Date.now(),
    savePath
  };
}
