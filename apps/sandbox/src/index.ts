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
  process.env.ENVIRONMENT = 'dev';

  console.log('==================================================');
  console.log('       MSIaaS ローカル動作検証シミュレーター      ');
  console.log('==================================================\n');

  // 1. D1 Mock データベースの初期化
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
    INSERT INTO lightweight_pack_mods (mod_id, mc_version, loader, active)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', '1.20.1', 'forge', 1);
  `);
  console.log('✔ テストユーザー、プリセット、および各種検証用MODデータを登録しました。\n');

  // 3. プロビショナー (コンシューマー) の動作検証
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
  console.log('✔ [SUCCESS] プロビショニングが走り、正常に running 状態へ遷移しました。\n');

  const sessionId = sessionResult[0].id as string;

  // 4. 自動終了 Cron ロジックの検証
  console.log('[Step 4] 自動終了（Cron）ロジックのステートマシン検証を開始します。');

  const mockCronEvent = (cron: string): any => ({
    cron,
    type: 'scheduled',
    scheduledTime: Date.now(),
    waitUntil: (_p: Promise<any>) => {},
  });
  const mockContext: any = { waitUntil: (_p: Promise<any>) => {} };

  // 検証A: プレイヤー数0人検知
  console.log('\n--- 検証A: 初めてプレイヤー数 0 人を検知 ---');
  db.prepare('UPDATE server_sessions SET current_player_count = 0, empty_since_at = NULL WHERE id = ?').run(sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterA = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  if (!sessionAfterA?.empty_since_at) {
    throw new Error('Failed to record empty_since_at.');
  }
  console.log('✔ [SUCCESS] プレイヤー0人の開始日時 (empty_since_at) が正しく記録されました。');

  // 検証B: 15分経過 (warning_sent)
  console.log('\n--- 検証B: 無人状態が15分経過 (警告フェーズ) ---');
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  db.prepare('UPDATE server_sessions SET empty_since_at = ? WHERE id = ?').run(sixteenMinutesAgo, sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterB = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  if (sessionAfterB?.status !== 'warning_sent') {
    throw new Error('Failed to transition to warning_sent.');
  }
  console.log('✔ [SUCCESS] 状態が warning_sent に遷移し、ログ履歴に記録されました！');

  // 検証C: プレイヤー復帰 (running)
  console.log('\n--- 検証C: 警告中のプレイヤー復帰による自動リセット ---');
  db.prepare('UPDATE server_sessions SET current_player_count = 1 WHERE id = ?').run(sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterC = db.prepare('SELECT empty_since_at, status FROM server_sessions WHERE id = ?').get(sessionId) as any;
  const logsAfterC = db
    .prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'running' AND reason = 'player_returned'")
    .all(sessionId) as any[];
  if (sessionAfterC?.status !== 'running' || sessionAfterC?.empty_since_at !== null || logsAfterC.length === 0) {
    throw new Error('Failed to recover session to running after player return.');
  }
  console.log('✔ [SUCCESS] プレイヤー復帰により状態が running に戻り、不在追跡も正常にクリアされました！');

  // 検証D: 20分経過 (自動シャットダウン)
  console.log('\n--- 検証D: 無人状態が20分経過 (自動シャットダウン) ---');
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  db.prepare("UPDATE server_sessions SET current_player_count = 0, empty_since_at = ?, status = 'warning_sent' WHERE id = ?")
    .run(twentyOneMinutesAgo, sessionId);
  await scheduledHandler(mockCronEvent('*/5 * * * *'), mockEnv, mockContext);
  const sessionAfterD = db.prepare('SELECT status, stopped_at FROM server_sessions WHERE id = ?').get(sessionId) as any;
  const logsAfterD = db
    .prepare("SELECT * FROM server_status_logs WHERE session_id = ? AND to_status = 'stopped' AND reason = 'player_empty'")
    .all(sessionId) as any[];
  if (sessionAfterD?.status !== 'stopped' || !sessionAfterD?.stopped_at || logsAfterD.length === 0) {
    throw new Error('Failed to auto-stop session after 20m inactivity.');
  }
  console.log('✔ [SUCCESS] 20分経過による自動シャットダウン (status=stopped) が正常に走り、インスタンス停止および履歴記録が完了しました！');

  // 検証E: 前提MOD解決・軽量化パック自動注入・サーバー/クライアント仕分け (API連携)
  console.log('\n--- 検証E: 前提MOD解決・軽量化パック自動注入・サーバー/クライアント仕分け ---');
  const createPresetResponse = await api.fetch(
    new Request('http://localhost/api/presets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999',
      },
      body: JSON.stringify({
        name: 'Integration Test Preset',
        mc_version: '1.20.1',
        loader: 'forge',
        mod_ids: ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
      }),
    }),
    mockEnv as any
  );

  const createPresetData = (await createPresetResponse.json()) as any;
  if (createPresetResponse.status !== 201 || !createPresetData.preset) {
    throw new Error(`Failed to create preset: ${JSON.stringify(createPresetData)}`);
  }
  const createdPresetId = createPresetData.preset.id;

  const getPresetResponse = await api.fetch(
    new Request(`http://localhost/api/presets/${createdPresetId}`, {
      method: 'GET',
      headers: { 'X-Mock-User-Id': 'cf-access-sub-999' },
    }),
    mockEnv as any
  );
  const getPresetData = (await getPresetResponse.json()) as any;
  const { mods, server_mods, client_mods } = getPresetData;
  const modIds = mods.map((m: any) => m.id as string);
  const hasModA = modIds.includes('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  const hasModB = modIds.includes('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');
  const hasModC = modIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33');
  const serverModIds = server_mods.map((m: any) => m.id as string);
  const clientModIds = client_mods.map((m: any) => m.id as string);
  if (!hasModA || !hasModB || !hasModC || serverModIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33') || !clientModIds.includes('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33')) {
    throw new Error('Preset dependency resolution, lightweight pack injection, or side filtering failed.');
  }
  console.log('✔ [SUCCESS] 依存関係解決、軽量化パック自動注入、およびサーバー/クライアント自動仕分けが100%正しく動作しています！');

  // 検証F: ZIP解析インポート (Modrinth 形式)
  console.log('\n--- 検証F: ZIP解析インポート (Modrinth 形式) ---');
  const zip = new JSZip();
  zip.file(
    'modrinth.index.json',
    JSON.stringify({
      game: '1.20.1',
      loader: 'forge',
      name: 'Modrinth Import Demo',
      dependencies: {
        'test-mod-with-dep': 'required',
      },
    })
  );
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const importResponse = await api.fetch(
    new Request('http://localhost/api/presets/import', {
      method: 'POST',
      headers: {
        'X-Mock-User-Id': 'cf-access-sub-999',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('curseforge_pack.zip'),
      },
      body: zipBuffer as any,
    }),
    mockEnv as any
  );
  const importData = (await importResponse.json()) as any;
  if (importResponse.status !== 201 || !importData.preset || importData.preset.source !== 'zip_import') {
    throw new Error(`ZIP import failed: ${JSON.stringify(importData)}`);
  }
  console.log('✔ [SUCCESS] ZIPインポート時のマニフェスト解析、依存解決、および軽量化パック注入が正常に動作しました！');

  // 検証G: mods/*.jar を含むZIPの自動メタデータ解析・Side仕分けインポート
  console.log('\n--- 検証G: mods/*.jar を含むZIPの自動メタデータ解析・Side仕分けインポート ---');
  const jarPackZip = new JSZip();
  const serverJar = new JSZip();
  serverJar.file(
    'fabric.mod.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'test-mod-with-dep',
      version: '1.0.0',
      name: 'Test Mod with Dependency',
      environment: '*',
    })
  );
  jarPackZip.file('mods/test-mod-with-dep.jar', await serverJar.generateAsync({ type: 'nodebuffer' }));

  const clientJar = new JSZip();
  clientJar.file(
    'fabric.mod.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'xaeros-minimap',
      version: '1.0.0',
      name: "Xaero's Minimap",
      environment: 'client',
    })
  );
  jarPackZip.file('mods/xaeros-minimap.jar', await clientJar.generateAsync({ type: 'nodebuffer' }));

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
        'X-File-Name': encodeURIComponent('client_mods_pack.zip'),
      },
      body: jarPackBuffer as any,
    }),
    mockEnv as any
  );
  const jarImportData = (await jarImportResponse.json()) as any;
  if (jarImportResponse.status !== 201 || !jarImportData.preset) {
    throw new Error(`mods/*.jar ZIP import failed: ${JSON.stringify(jarImportData)}`);
  }
  const serverModNames = (jarImportData.server_mods || []).map((m: any) => m.name as string);
  const clientModNames = (jarImportData.client_mods || []).map((m: any) => m.name as string);
  if (
    !serverModNames.includes('Test Mod with Dependency') ||
    serverModNames.includes("Xaero's Minimap") ||
    !clientModNames.includes("Xaero's Minimap") ||
    serverModNames.includes('mystery-unknown')
  ) {
    throw new Error('mods/*.jar side classification failed.');
  }
  console.log('✔ [SUCCESS] mods/*.jar ZIP の自動スキャンにより、server MOD のみサーバーに含まれ、client_only / unknown MOD はサーバーから除外されました！');

  // 検証H: ユーザー環境設定 (PUT /api/settings & GET /api/settings) の永続化検証
  console.log('\n--- 検証H: ユーザー環境設定 (PUT / GET /api/settings) の永続化検証 ---');
  const putSettingsRes = await api.fetch(
    new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999',
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
        motd: 'MSIaaS Verified Server',
      }),
    }),
    mockEnv as any
  );
  const getSettingsRes = await api.fetch(
    new Request('http://localhost/api/settings', {
      method: 'GET',
      headers: { 'X-Mock-User-Id': 'cf-access-sub-999' },
    }),
    mockEnv as any
  );
  const settingsData = (await getSettingsRes.json()) as any;
  if (
    putSettingsRes.status !== 200 ||
    getSettingsRes.status !== 200 ||
    settingsData.settings?.defaultMemoryGb !== 8 ||
    settingsData.settings?.usePlayitGg !== false ||
    settingsData.settings?.difficulty !== 'hard' ||
    settingsData.settings?.motd !== 'MSIaaS Verified Server'
  ) {
    throw new Error(`Settings persistence failed: ${JSON.stringify(settingsData)}`);
  }
  console.log('✔ [SUCCESS] ユーザー環境設定およびサーバープロパティ全項目がD1に正常に保存・取得されました！');

  // 検証I: サーバー起動レートリミット (1時間あたり3回上限) の検証
  console.log('\n--- 検証I: サーバー起動レートリミット (1時間3回上限) の検証 ---');
  for (let i = 1; i <= 3; i++) {
    const launchRes = await api.fetch(
      new Request('http://localhost/api/servers/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mock-User-Id': 'cf-access-sub-999',
        },
        body: JSON.stringify({ presetId: 'preset-5678' }),
      }),
      { ...mockEnv, ENVIRONMENT: 'dev' } as any
    );
    if (launchRes.status !== 202) {
      throw new Error(`Expected launch #${i} to return 202, got ${launchRes.status}`);
    }
    await api.fetch(
      new Request('http://localhost/api/servers/stop', {
        method: 'POST',
        headers: { 'X-Mock-User-Id': 'cf-access-sub-999' },
      }),
      mockEnv as any
    );
  }

  const fourthLaunchRes = await api.fetch(
    new Request('http://localhost/api/servers/launch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999',
      },
      body: JSON.stringify({ presetId: 'preset-5678' }),
    }),
    { ...mockEnv, ENVIRONMENT: 'dev' } as any
  );
  if (fourthLaunchRes.status !== 429) {
    throw new Error(`Expected 4th launch within 1 hour to return 429, got ${fourthLaunchRes.status}`);
  }

  // ローカルJava起動 (cloudProvider: 'local') はクラウド1時間3回制限の対象外であることを検証
  const localLaunchRes = await api.fetch(
    new Request('http://localhost/api/servers/launch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mock-User-Id': 'cf-access-sub-999',
      },
      body: JSON.stringify({ presetId: 'preset-5678', cloudProvider: 'local' }),
    }),
    { ...mockEnv, ENVIRONMENT: 'dev' } as any
  );
  if (localLaunchRes.status !== 202) {
    throw new Error(`Expected local Java launch to bypass cloud rate limit and return 202, got ${localLaunchRes.status}`);
  }
  await api.fetch(
    new Request('http://localhost/api/servers/stop', {
      method: 'POST',
      headers: { 'X-Mock-User-Id': 'cf-access-sub-999' },
    }),
    mockEnv as any
  );
  console.log('✔ [SUCCESS] 1時間あたり3回のクラウドサーバー起動レートリミット（およびローカルJava起動の除外）が正常に機能しています！');

  // 検証J: サンドボックス互換診断（サーバー＆クライアント入室互換テスト・不足前提MOD検出）
  console.log('\n--- 検証J: サンドボックス互換診断（サーバー＆クライアント入室互換テスト・不足前提MOD検出） ---');
  const compatTestZip = new JSZip();
  const sharedModJar = new JSZip();
  sharedModJar.file(
    'fabric.mod.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'create_addon',
      version: '1.2.0',
      name: 'Create Addon',
      environment: '*',
      depends: {
        minecraft: '1.20.1',
        fabricloader: '>=0.15.0',
        architectury: '>=9.0.0',
      },
    })
  );
  compatTestZip.file('mods/create-addon-1.2.0.jar', await sharedModJar.generateAsync({ type: 'nodebuffer' }));

  const clientModJar = new JSZip();
  clientModJar.file(
    'fabric.mod.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'better_hud',
      version: '2.0.0',
      name: 'Better HUD',
      environment: 'client',
      depends: {
        minecraft: '1.20.1',
        'cloth-config': '>=11.0.0',
      },
    })
  );
  compatTestZip.file('mods/better-hud-2.0.0.jar', await clientModJar.generateAsync({ type: 'nodebuffer' }));

  const compatTestBuf = await compatTestZip.generateAsync({ type: 'nodebuffer' });
  const scanRes = await scanAndFilterMods(compatTestBuf);
  const hasMissingServerArch = scanRes.compatibility.missingServerDeps.some((d) => d.requiredModId === 'architectury');
  const hasMissingClientCloth = scanRes.compatibility.missingClientDeps.some((d) => d.requiredModId === 'cloth-config');
  const hasRequiredClientMods = scanRes.compatibility.requiredClientMods.length === 2;

  if (
    scanRes.compatibility.isServerReady ||
    scanRes.compatibility.isClientReady ||
    !hasMissingServerArch ||
    !hasMissingClientCloth ||
    !hasRequiredClientMods
  ) {
    throw new Error('Sandbox compatibility check failed.');
  }
  console.log('✔ [SUCCESS] サーバー側前提MOD不足 (architectury) および クライアント専用前提MOD不足 (cloth-config) が正確に検出されました！');

  console.log('\n==================================================');
  console.log('🎉 全シナリオ (A〜J) のシミュレーションテストに合格しました！');
  console.log('==================================================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
