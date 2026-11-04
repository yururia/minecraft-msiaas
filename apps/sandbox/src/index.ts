// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import provisioner from '../../provisioner/src/index';
import { scheduledHandler } from '../../api/src/scheduled';
import api from '../../api/src/index';

async function main() {
  process.env.ENVIRONMENT = 'dev';

  console.log('==================================================');
  console.log('       MSIaaS ローカル動作検証シミュレーター      ');
  console.log('==================================================\n');

  console.log('[Step 1] メモリ内 SQLite データベースを初期化中...');
  const db = new DatabaseSync(':memory:');

  const migrationFiles = [
    '0000_initial.sql',
    '0001_add_local_provider.sql',
    '0002_add_java_columns.sql',
    '0003_add_user_settings_columns.sql',
    '0004_fix_schema_consistency.sql',
  ];

  for (const file of migrationFiles) {
    const schemaPath = path.resolve(process.cwd(), '../../infra/d1', file);
    console.log(`- スキーマ/マイグレーションを読込中: ${schemaPath}`);
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const sanitizedSql = schemaSql
      .replace(/PRAGMA journal_mode = WAL;/g, '')
      .replace(/PRAGMA foreign_keys = ON;/g, '')
      .replace(/PRAGMA foreign_keys = OFF;/g, '');
    db.exec(sanitizedSql);
  }
  console.log('✔ データベーススキーマおよび全マイグレーション (0000〜0004) の構築が完了しました。\n');

  class D1MockWrapper {
    private sqliteDb: DatabaseSync;
    constructor(sqliteDb: DatabaseSync) {
      this.sqliteDb = sqliteDb;
    }

    prepare(sql: string) {
      const stmt = this.sqliteDb.prepare(sql);
      return {
        bind: (...args: any[]) => {
          const normalizedArgs = args.map((arg) => (arg === undefined ? null : arg));
          return {
            run: async () => {
              stmt.run(...normalizedArgs);
              return { success: true };
            },
            all: async () => {
              const results = stmt.all(...normalizedArgs);
              return { results };
            },
            first: async () => {
              const results = stmt.all(...normalizedArgs);
              return results[0] || null;
            },
          };
        },
        run: async () => {
          stmt.run();
          return { success: true };
        },
        all: async () => {
          const results = stmt.all();
          return { results };
        },
        first: async () => {
          const results = stmt.all();
          return results[0] || null;
        },
      };
    }

    async batch(stmts: any[]) {
      for (const stmt of stmts) {
        await stmt.run();
      }
    }
  }

  const d1Mock = new D1MockWrapper(db) as any;

  console.log('[Step 2] テスト用マスタデータを投入中...');
  db.exec(`
    INSERT INTO users (id, external_id, email, plan, minecraft_uuid)
    VALUES ('user-1234', 'cf-access-sub-999', 'tester@example.com', 'free', 'mock-uuid-1111');

    INSERT INTO presets (id, user_id, name, mc_version, loader, resource_profile)
    VALUES ('preset-5678', 'user-1234', 'Vanilla Survival', '1.20.1', 'forge', 'standard');

    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'modrinth', 'sodium-mod', 'Sodium (Mock)', '1.20.1', 'forge', 'MIT', 'https://example.com/c.jar', 0, 1);

    INSERT INTO lightweight_pack_mods (mod_id, mc_version, loader, active)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', '1.20.1', 'forge', 1);
  `);
  console.log('✔ テストユーザー、プリセット、および各種検証用MODデータを登録しました。\n');

  console.log('[Step 3] プロビショナー (Queue Consumer) のシミュレーションを開始...');
  const mockBatch = {
    messages: [
      {
        body: { presetId: 'preset-5678', userId: 'user-1234' },
        ack: () => console.log('✔ Queue Message: ACK (正常処理完了)'),
        retry: () => console.log('✖ Queue Message: RETRY (再試行要求)'),
      },
    ],
  } as any;

  const mockEnv = { DB: d1Mock, ENVIRONMENT: 'dev' };
  await provisioner.queue(mockBatch, mockEnv);

  const sessionResult = db.prepare('SELECT * FROM server_sessions').all() as any[];
  if (sessionResult.length === 0 || sessionResult[0].status !== 'running') {
    throw new Error('Provisioner failed to transition session to running.');
  }

  // BUG FIX: Define sessionId from sessionResult[0].id and use .get() for single-row queries
  const sessionId = sessionResult[0].id as string;

  const mockCronEvent = (cron: string): any => ({
    cron,
    type: 'scheduled',
    scheduledTime: Date.now(),
    waitUntil: (_p: Promise<any>) => {},
  });
  const mockContext: any = { waitUntil: (_p: Promise<any>) => {} };

  // 検証A: プレイヤー数0人検知
  db.prepare('UPDATE server_sessions SET current_player_count = 0, empty_since_at = NULL WHERE id = ?').run(sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterA = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  if (!sessionAfterA?.empty_since_at) {
    throw new Error('Failed to record empty_since_at.');
  }

  // 検証B: 15分経過 (warning_sent)
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  db.prepare('UPDATE server_sessions SET empty_since_at = ? WHERE id = ?').run(sixteenMinutesAgo, sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterB = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  if (sessionAfterB?.status !== 'warning_sent') {
    throw new Error('Failed to transition to warning_sent.');
  }

  // 検証C: プレイヤー復帰 (running)
  db.prepare('UPDATE server_sessions SET current_player_count = 1 WHERE id = ?').run(sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterC = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  // BUG FIX: Match 'player_returned' with underscore
  const logsAfterC = db
    .prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'running' AND reason = 'player_returned'")
    .all(sessionId) as any[];
  if (sessionAfterC?.status !== 'running' || sessionAfterC?.empty_since_at !== null || logsAfterC.length === 0) {
    throw new Error('Failed to recover session to running after player return.');
  }

  console.log('✔ 全E2Eシミュレーション検証が完了しました！');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
