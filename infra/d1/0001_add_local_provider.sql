-- =============================================================================
-- Migration 0001: cloud_provider に 'local' を追加
--
-- SQLite は既存の CHECK 制約を ALTER TABLE で変更できないため、
-- 以下の手順でテーブルを再構築する：
--   1. 新テーブル (server_sessions_new) を正しい CHECK 制約で作成
--   2. 既存データをコピー
--   3. 旧テーブルを削除
--   4. 新テーブルをリネーム
--   5. インデックスを再作成
-- =============================================================================

-- 1. 外部キー制約の参照先テーブル (server_status_logs, crash_logs) を先に退避
PRAGMA foreign_keys = OFF;

-- 2. 新しい server_sessions テーブルを正しい制約で作成
CREATE TABLE IF NOT EXISTS server_sessions_new (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset_id            TEXT NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN (
                           'queued', 'provisioning', 'fallback',
                           'running', 'warning_sent',
                           'stopping', 'stopped', 'failed'
                         )),
  cloud_provider       TEXT
                         CHECK (cloud_provider IN ('oracle', 'aws', 'local')),
  instance_id          TEXT,
  tunnel_id            TEXT,
  ip_address           TEXT,
  current_player_count INTEGER NOT NULL DEFAULT 0,
  empty_since_at       TEXT,
  disk_used_mb         INTEGER NOT NULL DEFAULT 0,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at           TEXT
);

-- 3. 既存データをコピー
INSERT INTO server_sessions_new (
  id, user_id, preset_id, status, cloud_provider, instance_id, tunnel_id, ip_address,
  current_player_count, empty_since_at, disk_used_mb, started_at, stopped_at
)
SELECT
  id, user_id, preset_id, status, cloud_provider, instance_id, tunnel_id, ip_address,
  current_player_count, empty_since_at, disk_used_mb, started_at, stopped_at
FROM server_sessions;

-- 4. 旧テーブルを削除
DROP TABLE server_sessions;

-- 5. 新テーブルをリネーム
ALTER TABLE server_sessions_new RENAME TO server_sessions;

-- 6. インデックスを再作成
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_active_user
  ON server_sessions (user_id)
  WHERE stopped_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON server_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_preset_id ON server_sessions (preset_id);

PRAGMA foreign_keys = ON;
