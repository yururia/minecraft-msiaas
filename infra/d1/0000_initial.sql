-- =============================================================================
-- MSIaaS (Minecraft Server Infrastructure as a Service)
-- DB Schema v1.0  /  Cloudflare D1 (SQLite互換)
--
-- スコープ  : 全フェーズ（第1〜4期）
-- 設計方針  :
--   - ユーザー1人につき複数プリセット保存可
--   - サーバーステータスはFSM（遷移履歴テーブルあり）
--   - MODテーブルはModrinthキャッシュ兼用、sourceカラムで将来のCurseForge対応
--   - クラッシュログ・AI解析は第4期向け設計として含む
--   - 軽量化パック管理台帳をD1で管理
--   - 不在検知用に current_player_count + empty_since_at を sessions に持つ
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. users
--    Cloudflare Access が発行するJWTから external_id を抽出して紐付ける
--    plan は MVP段階では手動更新。第2期でStripe連携後に自動化
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  external_id              TEXT NOT NULL UNIQUE,   -- Cloudflare Access JWT の sub
  email                    TEXT NOT NULL,
  plan                     TEXT NOT NULL DEFAULT 'free'
                             CHECK (plan IN ('free', 'pro')),
  minecraft_uuid           TEXT,                   -- 未入力時はサーバー起動不可
  server_launch_count_1h   INTEGER NOT NULL DEFAULT 0, -- レートリミット管理（上限3回/h）
  last_launch_reset_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at               TEXT,                   -- 退会申請日時（30日後に物理削除）
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_external_id ON users (external_id);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at  ON users (deleted_at);

-- -----------------------------------------------------------------------------
-- 2. mods
--    Modrinth Cronキャッシュ兼マスタ（毎日UTC03:00更新 / 11.4節）
--    source = 'modrinth' | 'curseforge'（第2期以降）| 'manual'
--    is_lightweight_pack = TRUE のものが軽量化パック台帳の対象
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mods (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source            TEXT NOT NULL DEFAULT 'modrinth'
                      CHECK (source IN ('modrinth', 'curseforge', 'manual', 'zip_import')),
  external_id       TEXT,                  -- Modrinth project_id / CurseForge mod_id
  name              TEXT NOT NULL,
  mc_version        TEXT NOT NULL,         -- 例: '1.20.1'
  loader            TEXT NOT NULL
                      CHECK (loader IN ('forge', 'fabric', 'neoforge', 'quilt', 'any')),
  license           TEXT,                  -- 'MIT', 'LGPL-2.1', etc.
  download_url      TEXT,                  -- Modrinth CDN URL（ファイルはホストしない）
  is_server_side    INTEGER NOT NULL DEFAULT 1 CHECK (is_server_side IN (0,1)),
  is_client_side    INTEGER NOT NULL DEFAULT 1 CHECK (is_client_side IN (0,1)),
  is_lightweight_pack INTEGER NOT NULL DEFAULT 0 CHECK (is_lightweight_pack IN (0,1)),
  cached_at         TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (source, external_id, mc_version, loader)
);

CREATE INDEX IF NOT EXISTS idx_mods_mc_version_loader ON mods (mc_version, loader);
CREATE INDEX IF NOT EXISTS idx_mods_lightweight       ON mods (is_lightweight_pack, mc_version);

-- -----------------------------------------------------------------------------
-- 3. lightweight_pack_mods
--    軽量化パック管理台帳（2.1節）
--    mods.is_lightweight_pack との二重管理だが、
--    バージョンごとの有効/無効・追加日時を細かく管理するために独立テーブルとする
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lightweight_pack_mods (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  mod_id      TEXT NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  mc_version  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (mod_id, mc_version)
);

CREATE INDEX IF NOT EXISTS idx_lpm_mc_version_active ON lightweight_pack_mods (mc_version, active);

-- -----------------------------------------------------------------------------
-- 4. presets
--    MOD構成（1ユーザーが複数保存可能）
--    source = 'manual' | 'zip_import'（2.2節）
--    resource_profile = 'standard' | 'performance'（2.6節）
--    estimated_load はMOD解析エンジンが算出したスコア（リソースプロファイル選択に使用）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS presets (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  mc_version       TEXT NOT NULL,
  loader           TEXT NOT NULL
                     CHECK (loader IN ('forge', 'fabric', 'neoforge', 'quilt')),
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'zip_import')),
  estimated_load   INTEGER NOT NULL DEFAULT 0,  -- MOD解析エンジンが算出した負荷スコア
  resource_profile TEXT NOT NULL DEFAULT 'standard'
                     CHECK (resource_profile IN ('standard', 'performance')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_presets_user_id ON presets (user_id);

-- -----------------------------------------------------------------------------
-- 5. preset_mods  （presets と mods の中間テーブル）
--    manually_added = TRUE の場合はユーザーが明示的に追加したMOD
--    FALSE の場合は依存関係解決エンジンが自動追加した前提MOD（2.1節）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preset_mods (
  preset_id      TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  mod_id         TEXT NOT NULL REFERENCES mods(id) ON DELETE RESTRICT,
  manually_added INTEGER NOT NULL DEFAULT 1 CHECK (manually_added IN (0,1)),

  PRIMARY KEY (preset_id, mod_id)
);

CREATE INDEX IF NOT EXISTS idx_preset_mods_mod_id ON preset_mods (mod_id);

-- -----------------------------------------------------------------------------
-- 6. server_sessions
--    プリセット1回の起動 = 1レコード
--    同一ユーザーのrunning/provisioning/queuingセッションは1件のみ（一意制約）
--    tunnel_id : セッション終了時にAPIで確実に破棄するために保持（7.1節）
--    empty_since_at : プレイヤー0人になった時刻（自動停止ロジック用 / 2.3節）
--    disk_used_mb   : ストレージクォータ監視用（上限20GB = 20480MB / 2.6節）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_sessions (
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
                         CHECK (cloud_provider IN ('oracle', 'aws')),
  instance_id          TEXT,              -- OCI instance OCID / AWS instance-id
  tunnel_id            TEXT,              -- Cloudflare Tunnel ID（セッション終了時に破棄）
  ip_address           TEXT,              -- 第1期のみ（第3期で廃止 / 9節）
  current_player_count INTEGER NOT NULL DEFAULT 0,
  empty_since_at       TEXT,              -- プレイヤー0人になった時刻
  disk_used_mb         INTEGER NOT NULL DEFAULT 0,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at           TEXT
);

-- 同一ユーザーのアクティブセッションは1件のみ（6節 不正利用対策）
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_active_user
  ON server_sessions (user_id)
  WHERE stopped_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_user_id  ON server_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_preset_id ON server_sessions (preset_id);

-- -----------------------------------------------------------------------------
-- 7. server_status_logs  （FSMの遷移履歴）
--    status遷移一覧:
--      queued → provisioning → running → warning_sent → stopping → stopped
--      provisioning → fallback → provisioning（OCI失敗→AWSリトライ）
--      * → failed（両プロバイダー失敗時）
--    reason : 'player_empty', 'manual', 'fallback_aws', 'error', etc.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_status_logs (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id       TEXT NOT NULL REFERENCES server_sessions(id) ON DELETE CASCADE,
  from_status      TEXT,                  -- NULL = 初回遷移
  to_status        TEXT NOT NULL
                     CHECK (to_status IN (
                       'queued', 'provisioning', 'fallback',
                       'running', 'warning_sent',
                       'stopping', 'stopped', 'failed'
                     )),
  reason           TEXT,
  transitioned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_logs_session_id ON server_status_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_status_logs_transitioned_at ON server_status_logs (transitioned_at);

-- -----------------------------------------------------------------------------
-- 8. crash_logs  （第4期向け / 2.5節）
--    生ログはR2に保存（保持期間90日）。このテーブルはメタデータのみ管理
--    r2_key : R2上のオブジェクトキー
--    expires_at : 90日後（R2側の自動削除と合わせて管理）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crash_logs (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id  TEXT NOT NULL REFERENCES server_sessions(id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL,              -- 例: 'crash-logs/{session_id}/{uuid}.log'
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL               -- occurred_at + 90日
);

CREATE INDEX IF NOT EXISTS idx_crash_logs_session_id  ON crash_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_crash_logs_expires_at  ON crash_logs (expires_at);

-- -----------------------------------------------------------------------------
-- 9. ai_analysis_results  （第4期向け / 2.5節）
--    AI解析結果は無期限保存。ユーザー退会時に削除（5節）
--    mc_version / mod_snapshot は類似クラッシュの再発防止分析に使用
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_analysis_results (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  crash_log_id    TEXT NOT NULL UNIQUE REFERENCES crash_logs(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,          -- AI生成の日本語要約
  suggested_fix   TEXT NOT NULL,          -- AI生成の解決策（末尾に免責注記を付与）
  mc_version      TEXT NOT NULL,          -- 解析時のマイクラバージョン
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_results_mc_version ON ai_analysis_results (mc_version);
