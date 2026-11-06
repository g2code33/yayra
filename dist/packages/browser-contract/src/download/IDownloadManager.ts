/**
 * Yayra Floating Browser - Download Manager Contract & Interface
 */

import { DownloadRecord, DownloadState } from '../models/DownloadRecord.js';

export interface DownloadProgressEvent {
  downloadId: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number; // 0 to 100
}

export interface DownloadEvents {
  'download:started': (record: DownloadRecord) => void;
  'download:progress': (event: DownloadProgressEvent) => void;
  'download:completed': (record: DownloadRecord) => void;
  'download:failed': (record: DownloadRecord, error: string) => void;
  'download:cancelled': (record: DownloadRecord) => void;
  'download:state-changed': (record: DownloadRecord, previousState: DownloadState) => void;
}

export interface IDownloadManager {
  startDownload(url: string, suggestedFilename?: string, destinationPath?: string): Promise<DownloadRecord>;
  pauseDownload(downloadId: string): Promise<boolean>;
  resumeDownload(downloadId: string): Promise<boolean>;
  cancelDownload(downloadId: string): Promise<boolean>;
  getDownloads(): Promise<DownloadRecord[]>;
  getDownload(downloadId: string): Promise<DownloadRecord | null>;
  clearCompleted(): Promise<void>;
  on<K extends keyof DownloadEvents>(event: K, listener: DownloadEvents[K]): () => void;
}
