/**
 * DownloadRecord Model
 * Tracks local file downloads, progress, integrity, and lifecycle states.
 */

export type DownloadState =
  | 'pending'
  | 'in-progress'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export interface DownloadRecord {
  id: string;
  url: string;
  filename: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  startTime: number;
  endTime?: number;
  savePath: string;
  errorMessage?: string;
}

export function createDownloadRecord(
  url: string,
  filename: string,
  savePath: string,
  totalBytes = 0,
  mimeType?: string
): DownloadRecord {
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
