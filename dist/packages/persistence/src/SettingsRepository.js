/**
 * Yayra Floating Browser - Settings Repository
 */

import { DEFAULT_USER_SETTINGS } from '../../shared-core/src/types.js';

export class SettingsRepository {
  constructor(adapter) {
    this.adapter = adapter;
    this.SETTINGS_KEY = 'user-settings';
    this.GEOMETRY_KEY = 'window-geometry';
    this.BUBBLE_POS_KEY = 'bubble-position';
  }

  async getSettings() {
    const stored = await this.adapter.get(this.SETTINGS_KEY);
    return { ...DEFAULT_USER_SETTINGS, ...(stored || {}) };
  }

  async updateSettings(settings) {
    const current = await this.getSettings();
    const updated = { ...current, ...settings };
    await this.adapter.set(this.SETTINGS_KEY, updated);
    return updated;
  }

  async saveWindowGeometry(geometry) {
    await this.adapter.set(this.GEOMETRY_KEY, geometry);
  }

  async loadWindowGeometry() {
    return this.adapter.get(this.GEOMETRY_KEY);
  }

  async saveBubblePosition(pos) {
    await this.adapter.set(this.BUBBLE_POS_KEY, pos);
  }

  async loadBubblePosition() {
    return this.adapter.get(this.BUBBLE_POS_KEY);
  }
}
