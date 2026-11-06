/**
 * Yayra Floating Browser - Database Schema & Migration Definitions
 */

export const SQL_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_tab (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon TEXT,
    is_incognito INTEGER NOT NULL DEFAULT 0,
    zoom_level REAL NOT NULL DEFAULT 1.0,
    can_go_back INTEGER NOT NULL DEFAULT 0,
    can_go_forward INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_history (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon TEXT,
    visit_count INTEGER NOT NULL DEFAULT 1,
    last_visited_at INTEGER NOT NULL,
    is_incognito INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS browser_bookmark (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    url TEXT,
    favicon TEXT,
    is_folder INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_session (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    active_tab_id TEXT,
    window_geometry_json TEXT NOT NULL,
    bubble_position_json TEXT NOT NULL,
    is_private INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS download_record (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    total_bytes INTEGER NOT NULL,
    received_bytes INTEGER NOT NULL,
    state TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS browser_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme TEXT NOT NULL DEFAULT 'dark',
    search_engine TEXT NOT NULL DEFAULT 'duckduckgo',
    custom_search_url TEXT,
    start_url TEXT NOT NULL DEFAULT 'https://duckduckgo.com',
    homepage TEXT NOT NULL DEFAULT 'https://duckduckgo.com',
    default_zoom REAL NOT NULL DEFAULT 1.0,
    hardware_acceleration INTEGER NOT NULL DEFAULT 1,
    ad_block_enabled INTEGER NOT NULL DEFAULT 1,
    clear_history_on_exit INTEGER NOT NULL DEFAULT 0,
    glassmorphism_blur_radius INTEGER NOT NULL DEFAULT 20,
    glassmorphism_opacity REAL NOT NULL DEFAULT 0.88,
    custom_user_agent TEXT
);
CREATE TABLE IF NOT EXISTS floating_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    desktop_floating_mode TEXT NOT NULL DEFAULT 'circle-first',
    start_floating_on_launch INTEGER NOT NULL DEFAULT 1,
    always_on_top INTEGER NOT NULL DEFAULT 1,
    remember_position INTEGER NOT NULL DEFAULT 1,
    remember_size INTEGER NOT NULL DEFAULT 1,
    minimize_to_bubble INTEGER NOT NULL DEFAULT 1,
    close_to_tray INTEGER NOT NULL DEFAULT 1,
    start_with_windows INTEGER NOT NULL DEFAULT 0,
    bubble_x INTEGER NOT NULL DEFAULT 30,
    bubble_y INTEGER NOT NULL DEFAULT 120,
    bubble_snap_side TEXT NOT NULL DEFAULT 'left'
);
`;

export class DatabaseMigrationRunner {
  constructor() {
    this.migrations = [
      {
        version: 1,
        description: 'Initial 8-entity SQLDelight schema setup',
        migrate: async (adapter) => {
          await adapter.set('db_schema_version', 1);
        }
      },
      {
        version: 2,
        description: 'Add search terms indexing to history and snap physics to floating settings',
        migrate: async (adapter) => {
          const history = (await adapter.get('history-entries')) || [];
          const updated = history.map((h) => ({
            ...h,
            searchTerms: h.searchTerms || `${h.title} ${h.url}`.toLowerCase()
          }));
          await adapter.set('history-entries', updated);
          await adapter.set('db_schema_version', 2);
        }
      }
    ];
  }

  async runMigrations(adapter) {
    const currentVersion = (await adapter.get('db_schema_version')) || 0;
    let targetVersion = currentVersion;

    for (const step of this.migrations) {
      if (step.version > currentVersion) {
        await step.migrate(adapter);
        targetVersion = step.version;
      }
    }
    return targetVersion;
  }
}
