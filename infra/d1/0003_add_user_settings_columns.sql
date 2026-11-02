-- =============================================================================
-- Migration 0003: users テーブルに環境設定・サーバープロパティ用カラムを追加 (冪等テーブル再構築方式)
-- =============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS users_new (
  id                       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  external_id              TEXT NOT NULL UNIQUE,
  email                    TEXT NOT NULL,
  plan                     TEXT NOT NULL DEFAULT 'free'
                             CHECK (plan IN ('free', 'pro')),
  minecraft_uuid           TEXT,
  server_launch_count_1h   INTEGER NOT NULL DEFAULT 0,
  last_launch_reset_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  java_path                TEXT,
  default_memory_gb        INTEGER NOT NULL DEFAULT 4,
  use_playit_gg            INTEGER NOT NULL DEFAULT 1 CHECK (use_playit_gg IN (0,1)),
  pvp                      INTEGER NOT NULL DEFAULT 1 CHECK (pvp IN (0,1)),
  difficulty               TEXT NOT NULL DEFAULT 'easy' CHECK (difficulty IN ('peaceful', 'easy', 'normal', 'hard')),
  gamemode                 TEXT NOT NULL DEFAULT 'survival' CHECK (gamemode IN ('survival', 'creative', 'adventure', 'spectator')),
  max_players              INTEGER NOT NULL DEFAULT 20,
  allow_flight             INTEGER NOT NULL DEFAULT 0 CHECK (allow_flight IN (0,1)),
  white_list               INTEGER NOT NULL DEFAULT 0 CHECK (white_list IN (0,1)),
  view_distance            INTEGER NOT NULL DEFAULT 6,
  motd                     TEXT NOT NULL DEFAULT 'MSIaaS Local Server'
);

INSERT INTO users_new (
  id, external_id, email, plan, minecraft_uuid,
  server_launch_count_1h, last_launch_reset_at, deleted_at, created_at, updated_at
)
SELECT
  id, external_id, email, plan, minecraft_uuid,
  server_launch_count_1h, last_launch_reset_at, deleted_at, created_at, updated_at
FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_external_id ON users (external_id);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at  ON users (deleted_at);

PRAGMA foreign_keys = ON;
