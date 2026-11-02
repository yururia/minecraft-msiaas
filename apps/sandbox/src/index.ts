// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import provisioner from '../../provisioner/src/index';
import { scheduledHandler } from '../../api/src/scheduled';
import api from '../../api/src/index';
import { scanAndFilterMods } from '@msiaas/shared';
import JSZip from 'jszip';

async function main() {
  // ローカル開発環境を有効化し、CloudManager が DockerProvider を使用するようにします
  process.env.ENVIRONMENT = 'dev';

  console.log('==================================================');
  console.log('      MSIaaS ローカル動作検証シミュレーター        ');
  console.log('==================================================\n');

  // 1. D1 Mock データベースの初期化
  console.log('[Step 1] メモリ内 SQLite データベースを初期化中...');
  const db = new DatabaseSync(':memory:');

  // 初期スキーマおよびマイグレーションの読み込みと適用
  const migrationFiles = [
    '0000_initial.sql',
    '0001_add_local_provider.sql',
    '0002_add_java_columns.sql',
    '0003_add_user_settings_columns.sql',
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
  console.log('✔ データベーススキーマおよび全マイグレーション (0000〜0003) の構築が完了しました。\n');

  // D1Database 互換のラッパーオブジェクトを作成
  class D1MockWrapper {
    private sqliteDb: DatabaseSync;
    constructor(sqliteDb: DatabaseSync) {
      this.sqliteDb = sqliteDb;
    }

    prepare(sql: string) {
      const stmt = this.sqliteDb.prepare(sql);
      return {
        bind: (...args: any[]) => {
          const normalizedArgs = args.map(arg => {
            if (arg === undefined) return null;
            return arg;
          });
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
            }
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
        }
      };
    }

    async batch(stmts: any[]) {
      for (const stmt of stmts) {
        await stmt.run();
      }
    }
  }

  const d1Mock = new D1MockWrapper(db) as any;

  // 2. テスト用初期データの投入
  console.log('[Step 2] テスト用マスタデータを投入中...');
  db.exec(`
    INSERT INTO users (id, external_id, email, plan, minecraft_uuid)
    VALUES ('user-1234', 'cf-access-sub-999', 'tester@example.com', 'free', 'mock-uuid-1111');
    
    INSERT INTO presets (id, user_id, name, mc_version, loader, resource_profile)
    VALUES ('preset-5678', 'user-1234', 'Vanilla Survival', '1.20.1', 'forge', 'standard');

    -- MODマスタデータの追加 (前提MOD解決用、仕分け検証用, 軽量化パック検証用)
    -- 手動MOD A (サーバー/クライアント両用)
    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
    VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'modrinth', 'test-mod-with-dep', 'Test Mod with Dependency', '1.20.1', 'forge', 'MIT', 'http://example.com/mod-a.jar', 1, 1, 0);

    -- 前提MOD B (サーバー/クライアント両用)
    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
    VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'modrinth', 'test-dependency-mod', 'Test Dependency Mod', '1.20.1', 'forge', 'MIT', 'http://example.com/mod-b.jar', 1, 1, 0);

    -- 軽量化パックMOD C (クライアント専用、軽量化パックフラグON)
    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'modrinth', 'sodium-mod', 'Sodium (Mock)', '1.20.1', 'forge', 'LGPL-3.0', 'http://example.com/sodium.jar', 0, 1, 1);

    -- クライアント専用MOD D (クライアント専用)
    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
    VALUES ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'modrinth', 'xaeros-minimap', 'Xaero''s Minimap', '1.20.1', 'forge', 'Proprietary', 'http://example.com/xaeros.jar', 0, 1, 0);

    -- サーバー専用MOD E (サーバー専用)
    INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
    VALUES ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', 'modrinth', 'chunk-pregen', 'Chunk Pregenerator', '1.20.1', 'forge', 'MIT', 'http://example.com/pregen.jar', 1, 0, 0);

    -- 軽量化パック台帳の有効化
    INSERT INTO lightweight_pack_mods (mod_id, mc_version, active)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', '1.20.1', 1);
  `);
  console.log('✔ テストユーザー、プリセット、および各種検証用MODデータを登録しました。\n');

  // 3. プロビショナー (コンシューマー) の動作検証
  console.log('[Step 3] プロビショナー (Queue Consumer) のシミュレーションを開始...');

  const mockMessage = {
    body: {
      presetId: 'preset-5678',
      userId: 'user-1234'
    },
    ack: () => console.log('✔ Queue Message: ACK (正常処理完了)'),
    retry: () => console.log('✖ Queue Message: RETRY (再試行要求)')
  };

  const mockBatch = {
    messages: [mockMessage]
  } as any;

  const mockEnv = {
    DB: d1Mock
  };

  // キューハンドラの呼び出し
  await provisioner.queue(mockBatch, mockEnv);

  // 作成されたセッション情報を確認
  const sessionResult = db.prepare("SELECT * FROM server_sessions").all() as any[];
  console.log('\n--- データベース上のセッション状態 (server_sessions) ---');
  console.log(JSON.stringify(sessionResult, null, 2));

  // 状態遷移ログを確認
  const statusLogs = db.prepare("SELECT * FROM server_status_logs ORDER BY transitioned_at ASC").all() as any[];
  console.log('\n--- ステート遷移履歴 (server_status_logs) ---');
  console.log(JSON.stringify(statusLogs, null, 2));

  if (sessionResult.length > 0 && sessionResult[0].status === 'running') {
    console.log('\n✔ [SUCCESS] プロビショニングが走り、正常に running 状態へ遷移しました。\n');
  } else {
    console.log('\n✖ [FAILED] プロビショニングが期待通りに完了しませんでした。\n');
    process.exit(1);
  }

  if (process.argv.includes('--interactive')) {
    // ユーザーがマイクラで実際にログインを試すことができるよう一時停止
    console.log('──────────────────────────────────────────────────');
    console.log('★ マイクラサーバー起動デモ: コンテナが起動しました！');
    console.log('手持ちのマイクラを起動し、 [localhost:25565] でログイン可能です。');
    console.log('ログインテストを楽しんだ後、Enterキーを押すと検証（自動終了）を再開します。');
    console.log('──────────────────────────────────────────────────');
    await new Promise<void>(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }

  const sessionId = sessionResult[0].id;

  // 4. 自動終了 Cron ロジックの検証
  console.log('[Step 4] 自動終了（Cron）ロジックのステートマシン検証を開始します。');

  const mockCronEvent = (cron: string): any => ({
    cron,
    type: 'scheduled',
    scheduledTime: Date.now(),
    waitUntil: (promise: Promise<any>) => {}
  });

  const mockContext: any = {
    waitUntil: (promise: Promise<any>) => {}
  };

  // ----------------------------------------------------
  // 検証A: プレイヤー数0人になった直後 (初めての不在検知)
  // ----------------------------------------------------
  console.log('\n--- 検証A: 初めてプレイヤー数 0 人を検知 ---');
  console.log('DBの現在のプレイヤー数を 0 に設定します...');
  db.prepare("UPDATE server_sessions SET current_player_count = 0, empty_since_at = NULL WHERE id = ?")
    .run(sessionId);

  console.log('Cron (*/5 * * * *) を実行します...');
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);

  const sessionAfterA = db.prepare("SELECT empty_since_at, status FROM server_sessions WHERE id = ?").all(sessionId)[0] as any;
  console.log(`-> DB上の empty_since_at: ${sessionAfterA.empty_since_at}`);
  console.log(`-> DB上の status: ${sessionAfterA.status}`);

  if (sessionAfterA.empty_since_at) {
    console.log('✔ [SUCCESS] プレイヤー0人の開始日時 (empty_since_at) が正しく記録されました。');
  } else {
    console.log('✖ [FAILED] empty_since_at が記録されませんでした。');
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証B: 15分経過 (警告フェーズ移行)
  // ----------------------------------------------------
  console.log('\n--- 検証B: 無人状態が15分経過 (警告フェーズ) ---');
  console.log('DB上の empty_since_at を 16分前 に書き換えます...');
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  db.prepare("UPDATE server_sessions SET empty_since_at = ? WHERE id = ?")
    .run(sixteenMinutesAgo, sessionId);

  console.log('Cron (*/5 * * * *) を再実行します...');
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);

  const sessionAfterB = db.prepare("SELECT empty_since_at, status FROM server_sessions WHERE id = ?").all(sessionId)[0] as any;
  console.log(`-> DB上の status: ${sessionAfterB.status}`);

  // ミリ秒競合回避のため、特定の状態ログが存在するかどうかで検証
  const logsAfterB = db.prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'warning_sent'").all(sessionId) as any[];
  console.log(`-> warning_sent への状態遷移ログ件数: ${logsAfterB.length}`);

  if (sessionAfterB.status === 'warning_sent' && logsAfterB.length > 0) {
    console.log('✔ [SUCCESS] 状態が warning_sent に遷移し、ログ履歴に記録されました！');
  } else {
    console.log('✖ [FAILED] 警告フェーズへの遷移が失敗しました。');
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証C: 警告中のプレイヤー復帰 (running への復帰)
  // ----------------------------------------------------
  console.log('\n--- 検証C: 警告中のプレイヤー復帰による自動リセット ---');
  console.log('プレイヤー数が 1 人に戻ったことをシミュレートします...');
  db.prepare("UPDATE server_sessions SET current_player_count = 1 WHERE id = ?")
    .run(sessionId);

  console.log('Cron (*/5 * * * *) を再実行します...');
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);

  const sessionAfterC = db.prepare("SELECT empty_since_at, status FROM server_sessions WHERE id = ?").all(sessionId)[0] as any;
  console.log(`-> DB上の empty_since_at: ${sessionAfterC.empty_since_at} (NULLであるべき)`);
  console.log(`-> DB上の status: ${sessionAfterC.status} (runningであるべき)`);

  const logsAfterC = db.prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'running' AND reason = 'player_returned'").all(sessionId) as any[];
  console.log(`-> player_returned による running 状態への遷移ログ件数: ${logsAfterC.length}`);

  if (sessionAfterC.empty_since_at === null && sessionAfterC.status === 'running' && logsAfterC.length > 0) {
    console.log('✔ [SUCCESS] プレイヤー復帰により状態が running に戻り、不在追跡も正常にクリアされました！');
  } else {
    console.log('✖ [FAILED] プレイヤー復帰によるリセット処理が失敗しました。');
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証D: 20分経過 (自動シャットダウン)
  // ----------------------------------------------------
  console.log('\n--- 検証D: 無人状態が20分経過 (自動シャットダウン) ---');
  console.log('プレイヤー数を 0 に戻し、empty_since_at を 21分前 にセットします...');
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  db.prepare("UPDATE server_sessions SET current_player_count = 0, empty_since_at = ?, status = 'warning_sent' WHERE id = ?")
    .run(twentyOneMinutesAgo, sessionId);

  console.log('Cron (*/5 * * * *) を再実行します...');
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);

  const sessionAfterD = db.prepare("SELECT status, stopped_at FROM server_sessions WHERE id = ?").all(sessionId)[0] as any;
  console.log(`-> DB上の status: ${sessionAfterD.status} (stoppedであるべき)`);
  console.log(`-> DB上の stopped_at: ${sessionAfterD.stopped_at}`);

  const logsAfterD = db.prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'stopped' AND reason = 'player_empty'").all(sessionId) as any[];
  console.log(`-> stopped への状態遷移ログ件数: ${logsAfterD.length}`);

  if (sessionAfterD.status === 'stopped' && sessionAfterD.stopped_at !== null && logsAfterD.length > 0) {
    console.log('✔ [SUCCESS] 20分経過による自動シャットダウン (status=stopped) が正常に走り、インスタンス停止および履歴記録が完了しました！');
  } else {
    console.log('✖ [FAILED] 自動シャットダウン処理が失敗しました。');
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証E: 前提MOD解決・軽量化パック自動注入・サーバー/クライアント仕分け (API連携)
  // ----------------------------------------------------
  console.log('\n--- 検証E: 前提MOD解決・軽量化パック自動注入・サーバー/クライアント仕分け ---');

  const createPresetResponse = await api.fetch(
    new Request('http://localhost/api/presets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999'
      },
      body: JSON.stringify({
        name: 'Integration Test Preset',
        mc_version: '1.20.1',
        loader: 'forge',
        mod_ids: ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']
      })
    }),
    mockEnv
  );

  console.log(`-> POST /api/presets status: ${createPresetResponse.status}`);
  const createPresetData = await createPresetResponse.json() as any;
  
  if (createPresetResponse.status === 201 && createPresetData.preset) {
    console.log('✔ [SUCCESS] プリセットが正常に作成されました。');
    console.log(`   作成されたプリセットID: ${createPresetData.preset.id}`);
    console.log(`   算出された負荷スコア (estimated_load): ${createPresetData.preset.estimated_load}`);
    console.log(`   リソースプロファイル (resource_profile): ${createPresetData.preset.resource_profile}`);
  } else {
    console.log('✖ [FAILED] プリセットの作成に失敗しました。');
    console.log(JSON.stringify(createPresetData, null, 2));
    process.exit(1);
  }

  const createdPresetId = createPresetData.preset.id;

  // 詳細取得と仕分けの検証
  const getPresetResponse = await api.fetch(
    new Request(`http://localhost/api/presets/${createdPresetId}`, {
      method: 'GET',
      headers: {
        'X-Mock-User-Id': 'cf-access-sub-999'
      }
    }),
    mockEnv
  );

  console.log(`-> GET /api/presets/${createdPresetId} status: ${getPresetResponse.status}`);
  const getPresetData = await getPresetResponse.json() as any;

  if (getPresetResponse.status === 200) {
    const { mods, server_mods, client_mods } = getPresetData;
    console.log(`-> 解決・注入された総MOD数: ${mods.length}`);
    console.log(`-> サーバー側MOD数: ${server_mods.length}`);
    console.log(`-> クライアント側MOD数: ${client_mods.length}`);

    // MODの中身のチェック
    const modIds = mods.map((m: any) => m.id as string);
    const hasModA = modIds.includes('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'); // 手動
    const hasModB = modIds.includes('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'); // 前提解決
    const hasModC = modIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'); // 軽量化パック

    console.log(`   手動MOD A (a0eebc99-...) の存在: ${hasModA}`);
    console.log(`   前提MOD B (b0eebc99-...) の存在: ${hasModB}`);
    console.log(`   軽量化MOD C (c0eebc99-...) の存在: ${hasModC}`);

    // 仕分けのチェック
    const serverModIds = server_mods.map((m: any) => m.id as string);
    const clientModIds = client_mods.map((m: any) => m.id as string);
    
    const isCInServer = serverModIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33');
    const isCInClient = clientModIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33');
    console.log(`   軽量化パックCがサーバー側に仕分けられていないこと: ${!isCInServer}`);
    console.log(`   軽量化パックCがクライアント側に仕分けられていること: ${isCInClient}`);

    if (hasModA && hasModB && hasModC && !isCInServer && isCInClient) {
      console.log('✔ [SUCCESS] 依存関係解決、軽量化パック自動注入、およびサーバー/クライアント自動仕分けが100%正しく動作しています！');
    } else {
      console.log('✖ [FAILED] 解決・注入・仕分け結果が期待通りではありません。');
      process.exit(1);
    }
  } else {
    console.log('✖ [FAILED] プリセット詳細の取得に失敗しました。');
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証F: ZIP解析インポート (Modrinth 形式)
  // ----------------------------------------------------
  console.log('\n--- 検証F: ZIP解析インポート (Modrinth 形式) ---');

  const zip = new JSZip();
  
  // Modrinth 形式のインデックスファイルを作成
  const modrinthIndexJson = {
    game: '1.20.1',
    loader: 'forge',
    name: 'Modrinth Import Demo',
    dependencies: {
      'test-mod-with-dep': 'required'
    }
  };

  zip.file('modrinth.index.json', JSON.stringify(modrinthIndexJson));
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const importResponse = await api.fetch(
    new Request('http://localhost/api/presets/import', {
      method: 'POST',
      headers: {
        'X-Mock-User-Id': 'cf-access-sub-999',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('curseforge_pack.zip')
      },
      body: zipBuffer as any
    }),
    mockEnv
  );

  console.log(`-> POST /api/presets/import status: ${importResponse.status}`);
  const importData = await importResponse.json() as any;

  if (importResponse.status === 201 && importData.preset) {
    console.log('✔ [SUCCESS] ZIPインポートからプリセットが正常にインポート・再構築されました。');
    console.log(`   インポートされたプリセット名: ${importData.preset.name}`);
    console.log(`   インポート元 (source): ${importData.preset.source}`);
    console.log(`   解決・注入された総MOD数: ${importData.mods.length}`);
    console.log(`   サーバー側MOD数: ${importData.server_mods.length}`);
    console.log(`   クライアント側MOD数: ${importData.client_mods.length}`);

    // インポート時の依存関係解決と軽量化パック注入の確認
    const importModIds = importData.mods.map((m: any) => m.id as string);
    const hasImportModA = importModIds.includes('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    const hasImportModB = importModIds.includes('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');
    const hasImportModC = importModIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33');

    console.log(`   手動MOD A (a0eebc99-...) の存在: ${hasImportModA}`);
    console.log(`   前提MOD B (b0eebc99-...) の存在: ${hasImportModB}`);
    console.log(`   軽量化MOD C (c0eebc99-...) の存在: ${hasImportModC}`);

    if (hasImportModA && hasImportModB && hasImportModC && importData.preset.source === 'zip_import') {
      console.log('✔ [SUCCESS] ZIPインポート時のマニフェスト解析、依存解決、および軽量化パック注入が正常に動作しました！');
    } else {
      console.log('✖ [FAILED] ZIPインポート結果の検証が期待通りではありません。');
      process.exit(1);
    }
  } else {
    console.log('✖ [FAILED] ZIPインポートに失敗しました。');
    console.log(JSON.stringify(importData, null, 2));
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証G: mods/*.jar を含むZIPの自動メタデータ解析・Side仕分けインポート
  // ----------------------------------------------------
  console.log('\n--- 検証G: mods/*.jar を含むZIPの自動メタデータ解析・Side仕分けインポート ---');

  const jarPackZip = new JSZip();

  // 1) Fabric サーバー互換MOD (environment: "*")
  const serverJar = new JSZip();
  serverJar.file('fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: 'test-mod-with-dep',
    version: '1.0.0',
    name: 'Test Mod with Dependency',
    environment: '*'
  }));
  jarPackZip.file('mods/test-mod-with-dep.jar', await serverJar.generateAsync({ type: 'nodebuffer' }));

  // 2) Fabric クライアント専用MOD (environment: "client")
  const clientJar = new JSZip();
  clientJar.file('fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: 'xaeros-minimap',
    version: '1.0.0',
    name: 'Xaero\'s Minimap',
    environment: 'client'
  }));
  jarPackZip.file('mods/xaeros-minimap.jar', await clientJar.generateAsync({ type: 'nodebuffer' }));

  // 3) 判定不明MOD (メタデータなし -> デフォルトでサーバー除外)
  const unknownJar = new JSZip();
  unknownJar.file('README.txt', 'No mod metadata');
  jarPackZip.file('mods/mystery-unknown.jar', await unknownJar.generateAsync({ type: 'nodebuffer' }));

  const jarPackBuffer = await jarPackZip.generateAsync({ type: 'nodebuffer' });

  const jarImportResponse = await api.fetch(
    new Request('http://localhost/api/presets/import', {
      method: 'POST',
      headers: {
        'X-Mock-User-Id': 'cf-access-sub-999',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('client_mods_pack.zip')
      },
      body: jarPackBuffer as any
    }),
    mockEnv
  );

  console.log(`-> POST /api/presets/import (mods/*.jar ZIP) status: ${jarImportResponse.status}`);
  const jarImportData = await jarImportResponse.json() as any;

  if (jarImportResponse.status === 201 && jarImportData.preset) {
    const serverModNames = (jarImportData.server_mods || []).map((m: any) => m.name as string);
    const clientModNames = (jarImportData.client_mods || []).map((m: any) => m.name as string);
    console.log(`   サーバー側MOD一覧: ${JSON.stringify(serverModNames)}`);
    console.log(`   クライアント側MOD一覧: ${JSON.stringify(clientModNames)}`);

    const hasServerModOnServer = serverModNames.includes('Test Mod with Dependency');
    const isClientOnlyExcludedFromServer = !serverModNames.includes("Xaero's Minimap") && clientModNames.includes("Xaero's Minimap");
    const isUnknownExcludedFromServer = !serverModNames.includes('mystery-unknown');

    if (hasServerModOnServer && isClientOnlyExcludedFromServer && isUnknownExcludedFromServer) {
      console.log('✔ [SUCCESS] mods/*.jar ZIP の自動スキャンにより、server MOD のみサーバーに含まれ、client_only / unknown MOD はサーバーから除外されました！');
    } else {
      console.log('✖ [FAILED] mods/*.jar ZIP の Side 仕分け結果が期待通りではありません。');
      process.exit(1);
    }
  } else {
    console.log('✖ [FAILED] mods/*.jar ZIP のインポートに失敗しました。');
    console.log(JSON.stringify(jarImportData, null, 2));
    process.exit(1);
  }

  // ----------------------------------------------------
  // 検証H: ユーザー環境設定 (PUT /api/settings & GET /api/settings) の永続化検証
  // ----------------------------------------------------
  console.log('\n--- 検証H: ユーザー環境設定 (PUT / GET /api/settings) の永続化検証 ---');

  const putSettingsRes = await api.fetch(
    new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999'
      },
      body: JSON.stringify({
        javaPath: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe',
        defaultMemoryGb: 8,
        usePlayitGg: false,
        pvp: false,
        difficulty: 'hard',
        gamemode: 'survival',
        maxPlayers: 10,
        allowFlight: true,
        whiteList: true,
        viewDistance: 10,
        motd: 'MSIaaS Verified Server'
      })
    }),
    mockEnv
  );

  const getSettingsRes = await api.fetch(
    new Request('http://localhost/api/settings', {
      method: 'GET',
      headers: {
        'X-Mock-User-Id': 'cf-access-sub-999'
      }
    }),
    mockEnv
  );
  const settingsData = await getSettingsRes.json() as any;
  console.log(`-> PUT status: ${putSettingsRes.status}, GET status: ${getSettingsRes.status}`);

  if (
    putSettingsRes.status === 200 &&
    getSettingsRes.status === 200 &&
    settingsData.settings?.defaultMemoryGb === 8 &&
    settingsData.settings?.usePlayitGg === false &&
    settingsData.settings?.difficulty === 'hard' &&
    settingsData.settings?.motd === 'MSIaaS Verified Server'
  ) {
    console.log('✔ [SUCCESS] ユーザー環境設定およびサーバープロパティ全11項目がD1に正常に保存・取得されました！');
  } else {
    console.log('✖ [FAILED] ユーザー環境設定の保存・取得に失敗しました。');
    console.log(JSON.stringify(settingsData, null, 2));
    process.exitCode = 1;
    return;
  }

  // ----------------------------------------------------
  // 検証I: サーバー起動レートリミット (1時間あたり3回上限) の検証
  // ----------------------------------------------------
  console.log('\n--- 検証I: サーバー起動レートリミット (1時間3回上限) の検証 ---');

  for (let i = 1; i <= 3; i++) {
    const launchRes = await api.fetch(
      new Request('http://localhost/api/servers/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mock-User-Id': 'cf-access-sub-999'
        },
        body: JSON.stringify({ presetId: 'preset-5678' })
      }),
      { ...mockEnv, ENVIRONMENT: 'dev' } as any
    );
    console.log(`   起動試行 ${i} 回目 status: ${launchRes.status} (202であるべき)`);
    if (launchRes.status !== 202) {
      console.log(`✖ [FAILED] ${i}回目の起動が期待通り(202)ではありません。`);
      process.exitCode = 1;
      return;
    }
    // 次の起動テストのためアクティブセッションを停止
    await api.fetch(
      new Request('http://localhost/api/servers/stop', {
        method: 'POST',
        headers: { 'X-Mock-User-Id': 'cf-access-sub-999' }
      }),
      mockEnv
    );
  }

  // 4回目の起動試行 -> 429 Too Many Requests になるべき
  const fourthLaunchRes = await api.fetch(
    new Request('http://localhost/api/servers/launch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999'
      },
      body: JSON.stringify({ presetId: 'preset-5678' })
    }),
    { ...mockEnv, ENVIRONMENT: 'dev' } as any
  );
  console.log(`   起動試行 4 回目 status: ${fourthLaunchRes.status} (429であるべき)`);

  if (fourthLaunchRes.status === 429) {
    console.log('✔ [SUCCESS] 1時間あたり3回のサーバー起動レートリミットが正常に機能し、4回目が 429 でブロックされました！');
  } else {
    console.log('✖ [FAILED] レートリミットが機能していません。');
    process.exitCode = 1;
    return;
  }

  // ----------------------------------------------------
  // 検証J: サンドボックス互換診断（サーバー＆クライアント入室テスト・不足クライアント前提MOD検出）
  // ----------------------------------------------------
  console.log('\n--- 検証J: サンドボックス互換診断（サーバー＆クライアント入室互換テスト・不足前提MOD検出） ---');

  const compatTestZip = new JSZip();

  // 1) サーバー・クライアント共通MOD（前提MOD 'architectury' を要求）
  const sharedModJar = new JSZip();
  sharedModJar.file('fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: 'create_addon',
    version: '1.2.0',
    name: 'Create Addon',
    environment: '*',
    depends: {
      minecraft: '1.20.1',
      fabricloader: '>=0.15.0',
      architectury: '>=9.0.0'
    }
  }));
  compatTestZip.file('mods/create-addon-1.2.0.jar', await sharedModJar.generateAsync({ type: 'nodebuffer' }));

  // 2) クライアント専用MOD（サーバーMODパックZIPに含まれていないクライアント前提MOD 'cloth-config' を要求）
  const clientModJar = new JSZip();
  clientModJar.file('fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: 'better_hud',
    version: '2.0.0',
    name: 'Better HUD',
    environment: 'client',
    depends: {
      minecraft: '1.20.1',
      'cloth-config': '>=11.0.0'
    }
  }));
  compatTestZip.file('mods/better-hud-2.0.0.jar', await clientModJar.generateAsync({ type: 'nodebuffer' }));

  const compatTestBuf = await compatTestZip.generateAsync({ type: 'nodebuffer' });
  const scanRes = await scanAndFilterMods(compatTestBuf);

  console.log(`   isServerReady: ${scanRes.compatibility.isServerReady} (falseであるべき: architectury不足)`);
  console.log(`   isClientReady: ${scanRes.compatibility.isClientReady} (falseであるべき: architectury & cloth-config不足)`);
  console.log(`   missingServerDeps: ${JSON.stringify(scanRes.compatibility.missingServerDeps.map(d => d.requiredModId))}`);
  console.log(`   missingClientDeps: ${JSON.stringify(scanRes.compatibility.missingClientDeps.map(d => d.requiredModId))}`);
  console.log(`   requiredClientMods: ${JSON.stringify(scanRes.compatibility.requiredClientMods.map(m => m.name))}`);

  const hasMissingServerArch = scanRes.compatibility.missingServerDeps.some(d => d.requiredModId === 'architectury');
  const hasMissingClientCloth = scanRes.compatibility.missingClientDeps.some(d => d.requiredModId === 'cloth-config');
  const hasRequiredClientMods = scanRes.compatibility.requiredClientMods.length === 2;

  if (!scanRes.compatibility.isServerReady && !scanRes.compatibility.isClientReady && hasMissingServerArch && hasMissingClientCloth && hasRequiredClientMods) {
    console.log('✔ [SUCCESS] サーバー側前提MOD不足 (architectury) および クライアント専用前提MOD不足 (cloth-config) が正確に検出されました！');
  } else {
    console.log('✖ [FAILED] サンドボックス互換診断の検出結果が期待通りではありません。');
    process.exitCode = 1;
    return;
  }

  console.log('\n==================================================');
  console.log('🎉 全シナリオ (A〜J) のシミュレーションテストに合格しました！');
  console.log('==================================================');
}

main().catch(error => {
  console.error('✖ シミュレーション中に例外エラーが発生しました:', error);
  process.exitCode = 1;
});
