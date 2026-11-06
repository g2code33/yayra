/**
 * Yayra Floating Browser - Download Manager Contract (JS runtime)
 */

export class BaseDownloadManager {
  constructor() {
    this.downloads = new Map();
    this.listeners = new Map();
  }

  async startDownload(url, suggestedFilename = 'download', destinationPath = '/downloads') {
    const id = `dl_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const record = {
      id,
      url,
      filename: suggestedFilename,
      totalBytes: 0,
      receivedBytes: 0,
      state: 'in-progress',
      startTime: Date.now(),
      savePath: `${destinationPath}/${suggestedFilename}`
    };
    this.downloads.set(id, record);
    this.emit('download:started', record);
    return record;
  }

  async pauseDownload(downloadId) {
    const record = this.downloads.get(downloadId);
    if (!record || record.state !== 'in-progress') return false;
    const prev = record.state;
    record.state = 'paused';
    this.emit('download:state-changed', record, prev);
    return true;
  }

  async resumeDownload(downloadId) {
    const record = this.downloads.get(downloadId);
    if (!record || record.state !== 'paused') return false;
    const prev = record.state;
    record.state = 'in-progress';
    this.emit('download:state-changed', record, prev);
    return true;
  }

  async cancelDownload(downloadId) {
    const record = this.downloads.get(downloadId);
    if (!record) return false;
    const prev = record.state;
    record.state = 'cancelled';
    record.endTime = Date.now();
    this.emit('download:cancelled', record);
    this.emit('download:state-changed', record, prev);
    return true;
  }

  async getDownloads() {
    return Array.from(this.downloads.values());
  }

  async getDownload(downloadId) {
    return this.downloads.get(downloadId) || null;
  }

  async clearCompleted() {
    for (const [id, rec] of this.downloads.entries()) {
      if (['completed', 'cancelled', 'failed'].includes(rec.state)) {
        this.downloads.delete(id);
      }
    }
  }

  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  emit(event, ...args) {
    const cbs = this.listeners.get(event);
    if (cbs) {
      cbs.forEach((cb) => {
        try {
          cb(...args);
        } catch {
          // Ignore error in handler
        }
      });
    }
  }
}
