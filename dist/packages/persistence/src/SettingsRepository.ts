/**
 * Yayra Floating Browser - Settings Repository
 * Supports all BrowserSettings and FloatingSettings entities with local-first persistence.
 */

import { DEFAULT_USER_SETTINGS, SnapSide, UserSettings, WindowGeometry } from '../../shared-core/src/types.js';
import { IPersistenceAdapter, ISettingsRepository } from './IPersistenceEngine.js';

export class SettingsRepository implements ISettingsRepository {
  private adapter: IPersistenceAdapter;
  private readonly SETTINGS_KEY = 'user-settings';
  private readonly GEOMETRY_KEY = 'window-geometry';
  private readonly BUBBLE_POS_KEY = 'bubble-position';

  constructor(adapter: IPersistenceAdapter) {
    this.adapter = adapter;
  }

  public async getSettings(): Promise<UserSettings> {
    const stored = await this.adapter.get<UserSettings>(this.SETTINGS_KEY);
    return { ...DEFAULT_USER_SETTINGS, ...(stored || {}) };
  }

  public async updateSettings(settings: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings();
    const updated: UserSettings = { ...current, ...settings };
    await this.adapter.set(this.SETTINGS_KEY, updated);
    return updated;
  }

  public async saveWindowGeometry(geometry: WindowGeometry): Promise<void> {
    await this.adapter.set(this.GEOMETRY_KEY, geometry);
  }

  public async loadWindowGeometry(): Promise<WindowGeometry | null> {
    return this.adapter.get<WindowGeometry>(this.GEOMETRY_KEY);
  }

  public async saveBubblePosition(pos: { x: number; y: number; snapSide: SnapSide }): Promise<void> {
    await this.adapter.set(this.BUBBLE_POS_KEY, pos);
  }

  public async loadBubblePosition(): Promise<{ x: number; y: number; snapSide: SnapSide } | null> {
    return this.adapter.get<{ x: number; y: number; snapSide: SnapSide }>(this.BUBBLE_POS_KEY);
  }
}
