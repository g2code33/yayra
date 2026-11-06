/**
 * Yayra Floating Browser - Platform-Independent Browser Engine Interface (JS runtime)
 */

export class AbstractBrowserEngine {
  constructor() {
    this.listeners = new Map();
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
          // Ignore
        }
      });
    }
  }
}
