-- ===================================================================
-- Migration 0004: スキーマ整合性の修正 (Refactored)
--   1. server_status_logs に reason, transitioned_at カラムを保証
--   2. presets に description, estimated_load カラムおよび resource_profile ('performance' 等) を保証
--   3. lightweight_pack_mods.loader に DEFAULT 'forge' を設定
-- ===================================================================
PRAGMA foreign_keys = OFF;

-- 1. server_status_logs の再構築 (reason, detail, transitioned_at, created_at をすべてサポート)
CREATE TABLE IF NOT EXISTS server_status_logs_new (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT NOT NULL REFERENCES server_sessions(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  reason          TEXT,
  detail          TEXT,
  transitioned_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO server_status_logs_new (id, session_id, from_status, to_status, reason, detail, transitioned_at, created_at)
SELECT id, session_id, from_status, to_status,
       reason,
       reason,
       transitioned_at,
       transitioned_at
FROM server_status_logs;

DROP TABLE server_status_logs;
ALTER TABLE server_status_logs_new RENAME TO server_status_logs;
CREATE INDEX IF NOT EXISTS idx_status_logs_session ON server_status_logs (session_id, transitioned_at);

-- 2. presets の再構築 (description, estimated_load, resource_profile の制約統一)
CREATE TABLE IF NOT EXISTS presets_new (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  mc_version       TEXT NOT NULL,
  loader           TEXT NOT NULL CHECK (loader IN ('vanilla', 'forge', 'fabric', 'neoforge', 'quilt', 'paper')),
  estimated_load   INTEGER NOT NULL DEFAULT 0,
  resource_profile TEXT NOT NULL DEFAULT 'standard'
                     CHECK (resource_profile IN ('light', 'standard', 'heavy', 'performance')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO presets_new (id, user_id, name, description, mc_version, loader, estimated_load, resource_profile, created_at, updated_at)
SELECT id, user_id, name, '', mc_version, loader, estimated_load, resource_profile, created_at, updated_at
FROM presets;

DROP TABLE presets;
ALTER TABLE presets_new RENAME TO presets;
CREATE INDEX IF NOT EXISTS idx_presets_user_id ON presets (user_id);

-- 3. lightweight_pack_mods の再構築 (loader に DEFAULT 'forge' を設定)
CREATE TABLE IF NOT EXISTS lightweight_pack_mods_new (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mc_version  TEXT NOT NULL,
  loader      TEXT NOT NULL DEFAULT 'forge' CHECK (loader IN ('forge', 'fabric', 'neoforge', 'quilt', 'any')),
  mod_id      TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mc_version, loader, mod_id)
);

INSERT INTO lightweight_pack_mods_new (id, mc_version, loader, mod_id, active, note, created_at)
SELECT id, mc_version, 'forge', mod_id, active, NULL, created_at
FROM lightweight_pack_mods;

DROP TABLE lightweight_pack_mods;
ALTER TABLE lightweight_pack_mods_new RENAME TO lightweight_pack_mods;
CREATE INDEX IF NOT EXISTS idx_lpm_lookup ON lightweight_pack_mods (mc_version, loader, active);

PRAGMA foreign_keys = ON;
