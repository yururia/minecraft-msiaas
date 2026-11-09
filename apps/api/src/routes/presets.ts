import { Hono } from 'hono';
// cache-buster: presets-2026-05-26T21:34:44
import { zValidator } from '@hono/zod-validator';
import { Bindings } from '../index';
import { createPresetSchema, scanAndFilterMods } from '@msiaas/shared';
import { ModDbClient, KNOWN_MOD_ALIASES, normalizeModQuery } from '@msiaas/mod-db-tools';
import JSZip from 'jszip';

const presetsApp = new Hono<{ Bindings: Bindings, Variables: { user: any } }>();
const modClient = new ModDbClient();

/**
 * 前提MOD解決、軽量化パック自動注入、および中間テーブル登録用SQL生成、負荷スコア算出を行う共通ヘルパー
 */
async function processPresetMods(
  db: D1Database,
  presetId: string,
  mcVersion: string,
  loader: string,
  manualModIds: string[],
  curseForgeApiKey?: string
): Promise<{ estimatedLoad: number; resourceProfile: string; stmts: any[] }> {
  const stmts: any[] = [];
  
  // 1. 手動追加MODの情報をDBから引く (json_each を利用し、単一バインド変数で変数上限を永久に回避)
  let manualMods: any[] = [];
  if (manualModIds.length > 0) {
    const { results } = await db.prepare(
      `SELECT * FROM mods WHERE id IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(manualModIds)).all();
    if (results) {
      manualMods = results;
    }
  }

  // 手動追加MODをソース別に分類 (CurseForge と Modrinth が混在するプリセットでも両方の依存関係を並列解決する)
  const cfManualIds = manualMods
    .filter(m => m.source === 'curseforge' && m.external_id && !String(m.external_id).startsWith('local:'))
    .map(m => Number(m.external_id))
    .filter(id => !isNaN(id));

  const mrManualIds = manualMods
    .filter(m => m.source === 'modrinth' && m.external_id && !String(m.external_id).startsWith('local:'))
    .map(m => String(m.external_id));

  let resolvedCfExtIds: string[] = [];
  let resolvedMrExtIds: string[] = [];

  try {
    const [cfRes, mrRes] = await Promise.all([
      cfManualIds.length > 0
        ? modClient.resolveCurseForgeDependencies(cfManualIds, mcVersion, loader, curseForgeApiKey || '')
        : Promise.resolve([]),
      mrManualIds.length > 0
        ? modClient.resolveDependencies(mrManualIds, mcVersion, loader)
        : Promise.resolve([]),
    ]);
    resolvedCfExtIds = cfRes;
    resolvedMrExtIds = mrRes;
  } catch (depErr: any) {
    throw new Error(`前提MODの依存関係解決に失敗しました。\n・マイクラバージョン: ${mcVersion}\n・ローダー: ${loader}\n・システムエラー: ${depErr.message}\n\n【想定される原因】:\n1. MODパック内に、指定したマイクラバージョンやローダーに非対応のMODが混入している可能性があります。\n2. 配布元（CurseForge / Modrinth）から特定の前提MODが削除されたか、非公開に設定されています。\n3. APIの接続制限または一時的なサーバーダウンが発生しています。`);
  }

  const resolvedExternalIds = Array.from(new Set([...resolvedCfExtIds, ...resolvedMrExtIds]));

  // 解決された前提MODがマスタDBにあるか確認、無ければAPIから取得してキャッシュ (json_each を利用し、単一バインド変数で変数上限を永久に回避)
  const resolvedModIds: string[] = [];
  if (resolvedExternalIds.length > 0) {
    const { results } = await db.prepare(
      `SELECT * FROM mods WHERE external_id IN (SELECT value FROM json_each(?1)) AND mc_version = ?2 AND (loader = ?3 OR loader = 'any')`
    ).bind(JSON.stringify(resolvedExternalIds), mcVersion, loader).all();
    
    const existingResolved = results || [];

    const existingExtIds = new Set(existingResolved.map((m: any) => m.external_id as string));
    resolvedModIds.push(...existingResolved.map((m: any) => m.id as string));

    const missingCfIds = resolvedCfExtIds.filter(id => !existingExtIds.has(id)).map(Number).filter(id => !isNaN(id));
    const missingMrIds = resolvedMrExtIds.filter(id => !existingExtIds.has(id));

    if (missingCfIds.length > 0 || missingMrIds.length > 0) {
      const [fetchedCf, fetchedMr] = await Promise.all([
        missingCfIds.length > 0
          ? modClient.fetchModsFromCurseForge(missingCfIds, curseForgeApiKey || '', mcVersion, loader)
          : Promise.resolve([]),
        missingMrIds.length > 0
          ? modClient.fetchMods(missingMrIds, mcVersion, loader)
          : Promise.resolve([]),
      ]);
      const fetchedMods = [...fetchedCf, ...fetchedMr];

      for (const fetched of fetchedMods) {
        const newModId = crypto.randomUUID();
        const modLoader = (fetched as any).loader || loader;
        const modSource = fetched.source === 'curseforge' ? 'curseforge' : 'modrinth';
        await db.prepare(`
          INSERT OR IGNORE INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).bind(
          newModId,
          modSource,
          fetched.id,
          fetched.title,
          mcVersion,
          modLoader,
          fetched.license || 'Unknown',
          fetched.download_url || '',
          fetched.server_side === 'unsupported' ? 0 : 1,
          fetched.client_side === 'unsupported' ? 0 : 1
        ).run(); // 即座にキャッシュ

        resolvedModIds.push(newModId);
      }
    }
  }

  // 3. 軽量化パック自動注入
  // D1 から mcVersion & loader に適した軽量化パックを取得
  const { results: activeLightweightMods } = await db.prepare(`
    SELECT m.* 
    FROM lightweight_pack_mods lpm
    JOIN mods m ON lpm.mod_id = m.id
    WHERE lpm.mc_version = ? AND lpm.active = 1 AND (m.loader = ? OR m.loader = 'any')
  `).bind(mcVersion, loader).all();

  const lightweightModIds = activeLightweightMods.map((m: any) => m.id as string);

  // 4. 重複を排除して中間テーブル preset_mods にインサートするステートメントの作成
  const insertedModIds = new Set<string>();

  // 手動追加（manually_added = 1）
  manualModIds.forEach(modId => {
    if (!insertedModIds.has(modId)) {
      insertedModIds.add(modId);
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added) VALUES (?, ?, 1)')
          .bind(presetId, modId)
      );
    }
  });

  // 前提MOD（manually_added = 0）
  resolvedModIds.forEach(modId => {
    if (!insertedModIds.has(modId)) {
      insertedModIds.add(modId);
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added) VALUES (?, ?, 0)')
          .bind(presetId, modId)
      );
    }
  });

  // 軽量化パック（manually_added = 0）
  lightweightModIds.forEach((modId: string) => {
    if (!insertedModIds.has(modId)) {
      insertedModIds.add(modId);
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added) VALUES (?, ?, 0)')
          .bind(presetId, modId)
      );
    }
  });

  // 5. 負荷スコア & プロファイル判定
  const manualCount = manualModIds.length;
  const resolvedCount = resolvedModIds.length;
  const estimatedLoad = (manualCount * 10) + (resolvedCount * 5);
  const resourceProfile = estimatedLoad >= 50 ? 'performance' : 'standard';

  return { estimatedLoad, resourceProfile, stmts };
}

// GET /api/presets - ユーザーのプリセット一覧を取得
presetsApp.get('/', async (c) => {
  const user = c.get('user');
  
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM presets WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(user.id).all();
    return c.json({ presets: results });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/presets/:id - プリセットの詳細を取得 (仕分け機能つき)
presetsApp.get('/:id', async (c) => {
  const user = c.get('user');
  const presetId = c.req.param('id');
  
  try {
    const preset = await c.env.DB.prepare(
      'SELECT * FROM presets WHERE id = ? AND user_id = ?'
    ).bind(presetId, user.id).first();

    if (!preset) {
      return c.json({ error: 'Preset not found' }, 404);
    }

    const { results: mods } = await c.env.DB.prepare(`
      SELECT m.*, pm.manually_added 
      FROM preset_mods pm 
      JOIN mods m ON pm.mod_id = m.id 
      WHERE pm.preset_id = ?
    `).bind(presetId).all();

    // サーバー/クライアント自動仕分け (is_server_side / is_client_side)
    const server_mods = mods.filter((m: any) => m.is_server_side === 1);
    const client_mods = mods.filter((m: any) => m.is_client_side === 1);

    return c.json({ preset, mods, server_mods, client_mods });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/presets - プリセットを作成 (依存関係解決＆軽量化パック注入)
presetsApp.post('/', zValidator('json', createPresetSchema as any), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');
  const db = c.env.DB;
  
  try {
    const presetId = crypto.randomUUID();
    
    const { estimatedLoad, resourceProfile, stmts } = await processPresetMods(
      db,
      presetId,
      body.mc_version,
      body.loader,
      body.mod_ids || [],
      c.env.CURSEFORGE_API_KEY
    );

    // 同名プリセットの重複回避・自動リネーム
    const today = new Date().toISOString().split('T')[0];
    let finalPresetName = body.name;
    const existing = await db.prepare(
      'SELECT 1 FROM presets WHERE name = ? AND user_id = ?'
    ).bind(finalPresetName, user.id).first();

    if (existing) {
      finalPresetName = `${body.name} (${body.mc_version}) - ${today}`;
      let counter = 2;
      const baseName = finalPresetName;
      while (true) {
        const check = await db.prepare(
          'SELECT 1 FROM presets WHERE name = ? AND user_id = ?'
        ).bind(finalPresetName, user.id).first();
        if (!check) break;
        finalPresetName = `${baseName} (${counter})`;
        counter++;
      }
    }

    // プリセットの作成（INSERT）を先頭に追加
    stmts.unshift(
      db.prepare(`
        INSERT INTO presets (id, user_id, name, mc_version, loader, source, estimated_load, resource_profile)
        VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)
      `).bind(presetId, user.id, finalPresetName, body.mc_version, body.loader, estimatedLoad, resourceProfile)
    );

    // D1 のバッチ内変数合計制限を回避するため、極めて安全な 20 件ずつチャンク分割して実行
    const batchChunkSize = 20;
    for (let i = 0; i < stmts.length; i += batchChunkSize) {
      const chunk = stmts.slice(i, i + batchChunkSize);
      await db.batch(chunk);
    }

    // 成功後、作成されたプリセットを取得して返す
    const preset = await db.prepare('SELECT * FROM presets WHERE id = ?').bind(presetId).first();

    return c.json({ preset, message: 'Preset created successfully' }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/presets/import - ZIP解析インポート (CurseForge / Modrinth 形式)
presetsApp.post('/import', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    let mcVersion = '';
    let loader = 'fabric'; // デフォルト
    let presetName = 'Imported Pack';
    let externalIds: string[] = [];
    const cfFileIdMap: Record<number, number> = {};
    let source: 'curseforge' | 'modrinth' = 'curseforge';
    let scannedJarMods: Array<{
      fileName: string;
      modId: string;
      name: string;
      loader?: string;
      side?: string;
      isServerSide: boolean;
      isClientSide: boolean;
    }> = [];

    const contentType = c.req.header('Content-Type');

    if (contentType?.includes('application/json')) {
      // 🟢 新方式: クライアント側で事前に抽出された manifest JSON / scannedJarMods を直接受信
      const body = await c.req.json();
      const { fileName, manifest, modrinthIndex } = body;
      
      presetName = (fileName || 'Imported Pack').replace(/\.[^/.]+$/, "");
      if (body.mcVersion) mcVersion = body.mcVersion;
      if (body.loader) loader = body.loader;
      if (Array.isArray(body.scannedJarMods)) {
        scannedJarMods = body.scannedJarMods;
      }

      if (manifest) {
        source = 'curseforge';
        mcVersion = manifest.minecraft?.version || mcVersion;
        const loaderId = manifest.minecraft?.modLoaders?.[0]?.id || '';
        if (loaderId.includes('fabric')) {
          loader = 'fabric';
        } else if (loaderId.includes('forge')) {
          loader = 'forge';
        } else if (loaderId.includes('neoforge')) {
          loader = 'neoforge';
        } else if (loaderId.includes('quilt')) {
          loader = 'quilt';
        }
        presetName = manifest.name || presetName;
        if (manifest.files && Array.isArray(manifest.files)) {
          externalIds = manifest.files.map((f: any) => String(f.projectID));
          for (const f of manifest.files) {
            if (f.projectID && f.fileID) {
              cfFileIdMap[Number(f.projectID)] = Number(f.fileID);
            }
          }
        }
      } else if (modrinthIndex) {
        source = 'modrinth';
        mcVersion = modrinthIndex.game || mcVersion;
        loader = modrinthIndex.loader || loader || 'fabric';
        presetName = modrinthIndex.name || presetName;
        if (modrinthIndex.dependencies && typeof modrinthIndex.dependencies === 'object') {
          externalIds = Object.keys(modrinthIndex.dependencies);
        }
      } else if (scannedJarMods.length > 0) {
        // クライアント側で scanAndFilterMods によって抽出・確認された .jar 群のみで構成されたZIPパック
        source = 'modrinth';
        if (!mcVersion) mcVersion = '1.20.1';
        const detectedLoader = scannedJarMods.find(m => m.loader && m.loader !== 'unknown')?.loader;
        if (detectedLoader) loader = detectedLoader;
      } else {
        // もしmanifestもmodrinthIndexもない場合は、旧方式（Base64 JSON）にフォールバック
        let fileBase64 = body.fileBase64;
        let jsonName = body.fileName;
        if (fileBase64 && jsonName) {
          const binaryStr = atob(fileBase64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          const arrayBuffer = bytes.buffer;
          
          let zip;
          try {
            zip = await JSZip.loadAsync(arrayBuffer);
          } catch (zipErr: any) {
            return c.json({ error: `ZIPファイルの解析に失敗しました。\n・システムエラー: ${zipErr.message}` }, 400);
          }

          presetName = jsonName.replace(/\.[^/.]+$/, "");
          const manifestFile = zip.file('manifest.json');
          const modrinthFile = zip.file('modrinth.index.json');

          if (manifestFile) {
            source = 'curseforge';
            const content = await manifestFile.async('text');
            const manifestData = JSON.parse(content);
            mcVersion = manifestData.minecraft?.version || '';
            const loaderId = manifestData.minecraft?.modLoaders?.[0]?.id || '';
            if (loaderId.includes('fabric')) loader = 'fabric';
            else if (loaderId.includes('forge')) loader = 'forge';
            else if (loaderId.includes('neoforge')) loader = 'neoforge';
            else if (loaderId.includes('quilt')) loader = 'quilt';
            presetName = manifestData.name || presetName;
            if (manifestData.files && Array.isArray(manifestData.files)) {
              externalIds = manifestData.files.map((f: any) => String(f.projectID));
              for (const f of manifestData.files) {
                if (f.projectID && f.fileID) {
                  cfFileIdMap[Number(f.projectID)] = Number(f.fileID);
                }
              }
            }
          } else if (modrinthFile) {
            source = 'modrinth';
            const content = await modrinthFile.async('text');
            const indexData = JSON.parse(content);
            mcVersion = indexData.game || '';
            loader = indexData.loader || 'fabric';
            presetName = indexData.name || presetName;
            if (indexData.dependencies && typeof indexData.dependencies === 'object') {
              externalIds = Object.keys(indexData.dependencies);
            }
          } else {
            const scanResult = await scanAndFilterMods(arrayBuffer);
            if (scanResult.all.length > 0) {
              mcVersion = mcVersion || '1.20.1';
              const detected = scanResult.all.find(m => m.loader !== 'unknown')?.loader;
              if (detected) loader = detected;
              scannedJarMods = scanResult.all.map(m => ({
                fileName: m.fileName,
                modId: m.modId,
                name: m.name,
                loader: m.loader,
                side: m.side,
                isServerSide: m.side === 'server',
                isClientSide: true,
              }));
            } else {
              return c.json({ error: 'サポートされていないZIP形式です。manifest.json、modrinth.index.json、または mods/*.jar を含めてください。' }, 400);
            }
          }
        } else {
          return c.json({ error: 'インポートデータが送信されていません。' }, 400);
        }
      }
    } else {
      // 🟡 旧方式: ZIPファイルのバイナリを受信してサーバー側で解凍・解析
      let arrayBuffer: ArrayBuffer;
      let fileName = 'modpack.zip';
      const fileNameHeader = c.req.header('X-File-Name');

      if (contentType === 'application/octet-stream' && fileNameHeader) {
        fileName = decodeURIComponent(fileNameHeader);
        arrayBuffer = await c.req.arrayBuffer();
      } else {
        return c.json({ error: '不正な Content-Type です。' }, 400);
      }

      // 不正利用対策：ファイルサイズ上限 1GB
      if (arrayBuffer.byteLength > 1024 * 1024 * 1024) {
        return c.json({ error: 'ファイルサイズが上限（1GB）を超えています。' }, 400);
      }

      let zip;
      try {
        zip = await JSZip.loadAsync(arrayBuffer);
      } catch (zipErr: any) {
        return c.json({ error: `ZIPファイルの解析に失敗しました。ファイルが破損している可能性があります。\n・システムエラー: ${zipErr.message}` }, 400);
      }

      presetName = fileName.replace(/\.[^/.]+$/, "");
      const manifestFile = zip.file('manifest.json');
      const modrinthFile = zip.file('modrinth.index.json');

      if (manifestFile) {
        source = 'curseforge';
        try {
          const content = await manifestFile.async('text');
          const manifest = JSON.parse(content);
          mcVersion = manifest.minecraft?.version || '';
          const loaderId = manifest.minecraft?.modLoaders?.[0]?.id || '';
          if (loaderId.includes('fabric')) {
            loader = 'fabric';
          } else if (loaderId.includes('forge')) {
            loader = 'forge';
          } else if (loaderId.includes('neoforge')) {
            loader = 'neoforge';
          } else if (loaderId.includes('quilt')) {
            loader = 'quilt';
          }
          presetName = manifest.name || presetName;
          if (manifest.files && Array.isArray(manifest.files)) {
            externalIds = manifest.files.map((f: any) => String(f.projectID));
          }
        } catch (jsonErr: any) {
          return c.json({ error: `manifest.json の解析に失敗しました。\n・システムエラー: ${jsonErr.message}` }, 400);
        }
      } else if (modrinthFile) {
        source = 'modrinth';
        try {
          const content = await modrinthFile.async('text');
          const indexData = JSON.parse(content);
          mcVersion = indexData.game || '';
          loader = indexData.loader || 'fabric';
          presetName = indexData.name || presetName;
          if (indexData.dependencies && typeof indexData.dependencies === 'object') {
            externalIds = Object.keys(indexData.dependencies);
          }
        } catch (jsonErr: any) {
          return c.json({ error: `modrinth.index.json の解析に失敗しました。\n・システムエラー: ${jsonErr.message}` }, 400);
        }
      } else {
        const scanResult = await scanAndFilterMods(arrayBuffer);
        if (scanResult.all.length > 0) {
          mcVersion = '1.20.1';
          const detected = scanResult.all.find(m => m.loader !== 'unknown')?.loader;
          if (detected) loader = detected;
          scannedJarMods = scanResult.all.map(m => ({
            fileName: m.fileName,
            modId: m.modId,
            name: m.name,
            loader: m.loader,
            side: m.side,
            isServerSide: m.side === 'server',
            isClientSide: true,
          }));
        } else {
          return c.json({ error: 'サポートされていないZIP形式です。manifest.json、modrinth.index.json、または mods/*.jar を含めてください。' }, 400);
        }
      }
    }

    if (!mcVersion) {
      return c.json({ error: `MODパックから Minecraft バージョンを検出できませんでした。\nマニフェスト（manifest.json または modrinth.index.json）の記述内容をご確認ください。` }, 400);
    }

    // 抽出された externalIds からDBの mods データを引く、なければフェッチしてキャッシュ (json_each を利用し、単一バインド変数で変数上限を永久に回避)
    const modIds: string[] = [];
    if (externalIds.length > 0) {
      const { results } = await db.prepare(
        `SELECT * FROM mods WHERE external_id IN (SELECT value FROM json_each(?1)) AND mc_version = ?2 AND (loader = ?3 OR loader = 'any') AND source = ?4`
      ).bind(JSON.stringify(externalIds), mcVersion, loader, source).all();
      
      const existingMods = results || [];

      const existingExtIds = new Set(existingMods.map((m: any) => m.external_id as string));
      const missingExtIds = externalIds.filter(id => !existingExtIds.has(id));

      modIds.push(...existingMods.map((m: any) => m.id as string));

      if (missingExtIds.length > 0) {
        let fetchedMods: any[] = [];
        try {
          if (source === 'curseforge') {
            const numericIds = missingExtIds.map(Number).filter(id => !isNaN(id));
            fetchedMods = await modClient.fetchModsFromCurseForge(
              numericIds,
              c.env.CURSEFORGE_API_KEY || '',
              mcVersion,
              loader,
              cfFileIdMap
            );
          } else {
            fetchedMods = await modClient.fetchMods(missingExtIds, mcVersion, loader);
          }
        } catch (fetchErr: any) {
          return c.json({
            error: `MOD情報の取得に失敗しました。\n\n【詳細原因】:\n外部API (${source === 'curseforge' ? 'CurseForge' : 'Modrinth'}) からのMODデータ取得中にエラーが発生しました。\n・システムエラー: ${fetchErr.message}\n・不足しているMODのID: ${missingExtIds.join(', ')}\n\n【想定される原因】:\n・インターネット接続の一時的な切断、または配布サイトのAPIダウン。\n・一部のMODが非公開、配布元から削除、または該当プラットフォーム上で見つからない状態になっています。`
          }, 400);
        }

        for (const fetched of fetchedMods) {
          const newModId = crypto.randomUUID();
          const modLoader = (fetched as any).loader || loader;
          await db.prepare(`
            INSERT OR IGNORE INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).bind(
            newModId,
            source,
            fetched.id,
            fetched.title,
            mcVersion,
            modLoader,
            fetched.license || 'Unknown',
            fetched.download_url || '',
            fetched.server_side === 'unsupported' ? 0 : 1,
            fetched.client_side === 'unsupported' ? 0 : 1
          ).run();

          modIds.push(newModId);
        }
      }
    }

    // クライアント側またはサーバー側でスキャンされた .jar MOD 群の登録・Side判定結果反映
    for (const jarMod of scannedJarMods) {
      const extId = `local:${jarMod.modId || jarMod.fileName}`;
      const modLoader = (jarMod.loader && jarMod.loader !== 'unknown') ? jarMod.loader : loader;
      const isSrv = jarMod.isServerSide ? 1 : 0;
      const isCli = jarMod.isClientSide !== false ? 1 : 0;

      const existingLocal = await db.prepare(
        `SELECT id FROM mods WHERE external_id = ? AND mc_version = ? AND (loader = ? OR loader = 'any')`
      ).bind(extId, mcVersion, modLoader).first<{ id: string }>();

      if (existingLocal) {
        await db.prepare(
          `UPDATE mods SET is_server_side = ?, is_client_side = ?, name = ? WHERE id = ?`
        ).bind(isSrv, isCli, jarMod.name || jarMod.fileName, existingLocal.id).run();
        modIds.push(existingLocal.id);
      } else {
        const newLocalId = crypto.randomUUID();
        await db.prepare(`
          INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
          VALUES (?, 'manual', ?, ?, ?, ?, 'Custom JAR', '', ?, ?, 0)
        `).bind(
          newLocalId,
          extId,
          jarMod.name || jarMod.fileName,
          mcVersion,
          modLoader,
          isSrv,
          isCli
        ).run();
        modIds.push(newLocalId);
      }
    }

    // プリセットUUIDの生成
    const presetId = crypto.randomUUID();

    // 共通ヘルパーを実行
    let estimatedLoad = 0;
    let resourceProfile = 'Lightweight';
    let stmts: any[] = [];
    try {
      const result = await processPresetMods(
        db,
        presetId,
        mcVersion,
        loader,
        modIds,
        c.env.CURSEFORGE_API_KEY
      );
      estimatedLoad = result.estimatedLoad;
      resourceProfile = result.resourceProfile;
      stmts = result.stmts;
    } catch (procErr: any) {
      return c.json({
        error: `MODの依存関係解決、または構成チェックに失敗しました。\n\n【詳細原因】:\n${procErr.message}\n\n【想定される原因・対策】:\n1. MODパック内のMOD同士でバージョンの競合や、対象バージョン「${mcVersion}」に非対応のMODが含まれています。\n2. このマイクラのバージョン「${mcVersion}」およびローダー「${loader}」の組み合わせに対して、必要な前提MODの解決ができませんでした。`
      }, 400);
    }

    // 同名プリセットの重複回避・自動リネーム
    const today = new Date().toISOString().split('T')[0];
    let finalPresetName = presetName;
    const existing = await db.prepare(
      'SELECT 1 FROM presets WHERE name = ? AND user_id = ?'
    ).bind(finalPresetName, user.id).first();

    if (existing) {
      finalPresetName = `${presetName} (${mcVersion}) - ${today}`;
      let counter = 2;
      const baseName = finalPresetName;
      while (true) {
        const check = await db.prepare(
          'SELECT 1 FROM presets WHERE name = ? AND user_id = ?'
        ).bind(finalPresetName, user.id).first();
        if (!check) break;
        finalPresetName = `${baseName} (${counter})`;
        counter++;
      }
    }

    // プリセット本体のINSERTステートメントを追加
    stmts.unshift(
      db.prepare(`
        INSERT INTO presets (id, user_id, name, mc_version, loader, source, estimated_load, resource_profile)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(presetId, user.id, finalPresetName, mcVersion, loader, 'zip_import', estimatedLoad, resourceProfile)
    );

    // 一括実行 (D1 のバッチ内変数合計制限を回避するため、80件ずつチャンク分割して実行)
    try {
      // 極めて安全な 20 件ずつチャンク分割して実行
      const batchChunkSize = 20;
      for (let i = 0; i < stmts.length; i += batchChunkSize) {
        const chunk = stmts.slice(i, i + batchChunkSize);
        await db.batch(chunk);
      }
    } catch (dbErr: any) {
      return c.json({
        error: `データベースへのプリセット登録に失敗しました。\n\n【システムエラー】: ${dbErr.message}\n\n【対策】: アプリケーションデータベース（D1）の状態をご確認ください。`
      }, 500);
    }

    // 作成されたプリセット詳細を取得
    const preset = await db.prepare('SELECT * FROM presets WHERE id = ?').bind(presetId).first();
    const { results: finalMods } = await db.prepare(`
      SELECT m.*, pm.manually_added 
      FROM preset_mods pm 
      JOIN mods m ON pm.mod_id = m.id 
      WHERE pm.preset_id = ?
    `).bind(presetId).all();

    const server_mods = finalMods.filter((m: any) => m.is_server_side === 1);
    const client_mods = finalMods.filter((m: any) => m.is_client_side === 1);

    return c.json({
      preset,
      mods: finalMods,
      server_mods,
      client_mods,
      message: 'Modpack imported successfully'
    }, 201);

  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/presets/:id/mods - 特定のプリセットIDに含まれる全MOD一括返却（同期MOD用）
presetsApp.get('/:id/mods', async (c) => {
  const db = c.env.DB;
  const presetId = c.req.param('id');
  
  try {
    // プリセットの存在確認
    const preset = await db.prepare(
      'SELECT id, mc_version, loader FROM presets WHERE id = ?'
    ).bind(presetId).first();

    if (!preset) {
      return c.json({ error: 'Preset not found' }, 404);
    }

    // 中間テーブル preset_mods から、紐づく全MODのダウンロード情報および side 判定フラグを一括取得
    const { results: mods } = await db.prepare(`
      SELECT m.id, m.name, m.source, m.external_id, m.download_url, m.mc_version, m.loader, m.is_server_side, m.is_client_side, pm.manually_added
      FROM preset_mods pm
      JOIN mods m ON pm.mod_id = m.id
      WHERE pm.preset_id = ?
    `).bind(presetId).all();

    return c.json({ mods });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// PUT /api/presets/:id - プリセット名を更新
presetsApp.put('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const { name } = body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'Name is required' }, 400);
    }

    // 同名チェック・自動重複回避
    const today = new Date().toISOString().split('T')[0];
    let finalPresetName = name.trim();
    const existing = await db.prepare(
      'SELECT 1 FROM presets WHERE name = ? AND user_id = ? AND id != ?'
    ).bind(finalPresetName, user.id, id).first();

    if (existing) {
      const preset = await db.prepare(
        'SELECT mc_version FROM presets WHERE id = ?'
      ).bind(id).first<any>();
      const mcVersion = preset?.mc_version || 'unknown';

      finalPresetName = `${name.trim()} (${mcVersion}) - ${today}`;
      let counter = 2;
      const baseName = finalPresetName;
      while (true) {
        const check = await db.prepare(
          'SELECT 1 FROM presets WHERE name = ? AND user_id = ? AND id != ?'
        ).bind(finalPresetName, user.id, id).first();
        if (!check) break;
        finalPresetName = `${baseName} (${counter})`;
        counter++;
      }
    }

    await db.prepare(
      'UPDATE presets SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
    ).bind(finalPresetName, id, user.id).run();

    return c.json({ ok: true, name: finalPresetName, message: 'Preset updated successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// PUT /api/presets/:id/mods - プリセット内のMOD構成（手動追加）を一括更新し、前提関係を再計算
presetsApp.put('/:id/mods', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const presetId = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const { mod_ids } = body; // 手動追加MODのUUID配列

    if (!Array.isArray(mod_ids)) {
      return c.json({ error: 'mod_ids (array) is required.' }, 400);
    }

    // 1. プリセットの所有権と存在チェック
    const preset = await db.prepare(
      'SELECT mc_version, loader FROM presets WHERE id = ? AND user_id = ?'
    ).bind(presetId, user.id).first<any>();

    if (!preset) {
      return c.json({ error: 'Preset not found' }, 404);
    }

    // 2. サーバーが実際に稼働中（running / warning_sent）の場合は編集を禁止し、スタックした queued 等は自動クリーンアップする
    const activeSessions = await db.prepare(
      'SELECT id, status FROM server_sessions WHERE preset_id = ? AND stopped_at IS NULL'
    ).bind(presetId).all<any>();

    for (const s of activeSessions.results || []) {
      if (s.status === 'running' || s.status === 'warning_sent') {
        return c.json({ error: 'このプリセットは現在サーバーが稼働中のためMOD構成を変更できません。サーバーを停止してからお試しください。' }, 400);
      } else {
        // 起動準備のまま中断された queued / provisioning セッションは自動的にクローズしてMOD編集を許可する
        await db.prepare(
          "UPDATE server_sessions SET status = 'stopped', stopped_at = datetime('now') WHERE id = ?"
        ).bind(s.id).run();
      }
    }

    // 3. 既存の preset_mods から、どのMODが新しく手動追加されたかを特定（すでに解決済みの200+件を毎回再計算してタイムアウトするのを防ぐ）
    const { results: existingRows } = await db.prepare(
      'SELECT mod_id, manually_added FROM preset_mods WHERE preset_id = ?'
    ).bind(presetId).all<{ mod_id: string; manually_added: number }>();
    const existingManualIdSet = new Set(
      (existingRows || []).filter(r => r.manually_added === 1).map(r => r.mod_id)
    );
    const newlyAddedModIds = mod_ids.filter((id: string) => !existingManualIdSet.has(id));
    const isIncrementalAdd = newlyAddedModIds.length > 0 && newlyAddedModIds.length <= 10 && mod_ids.length > 20;

    // 既存の中間テーブル preset_mods データを一旦削除
    const deleteStmt = db.prepare('DELETE FROM preset_mods WHERE preset_id = ?').bind(presetId);

    // 4. 新しい手動MOD配列をもとに前提MOD解決 & 軽量化パック注入
    // 大型パックへの個別MOD追加時は新規追加MODのみ依存解決を行い、既存の全MOD（前提MOD含む）を維持することで高速・確実に反映する
    let estimatedLoad = 0;
    let resourceProfile = 'standard';
    let stmts: any[] = [];

    if (isIncrementalAdd) {
      const incResult = await processPresetMods(
        db,
        presetId,
        preset.mc_version,
        preset.loader,
        newlyAddedModIds,
        c.env.CURSEFORGE_API_KEY
      );
      stmts = [...incResult.stmts];
      const scheduledIds = new Set<string>(newlyAddedModIds);
      for (const modId of mod_ids) {
        if (!scheduledIds.has(modId)) {
          scheduledIds.add(modId);
          stmts.push(
            db.prepare('INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added) VALUES (?, ?, 1)')
              .bind(presetId, modId)
          );
        }
      }
      for (const row of existingRows || []) {
        if (!scheduledIds.has(row.mod_id)) {
          scheduledIds.add(row.mod_id);
          stmts.push(
            db.prepare('INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added) VALUES (?, ?, ?)')
              .bind(presetId, row.mod_id, row.manually_added)
          );
        }
      }
      estimatedLoad = mod_ids.length * 10;
      resourceProfile = estimatedLoad >= 50 ? 'performance' : 'standard';
    } else {
      const fullResult = await processPresetMods(
        db,
        presetId,
        preset.mc_version,
        preset.loader,
        mod_ids,
        c.env.CURSEFORGE_API_KEY
      );
      estimatedLoad = fullResult.estimatedLoad;
      resourceProfile = fullResult.resourceProfile;
      stmts = fullResult.stmts;
    }

    // 5. プリセット自体のメタデータを更新するステートメントを追加
    const updatePresetStmt = db.prepare(`
      UPDATE presets 
      SET estimated_load = ?, resource_profile = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).bind(estimatedLoad, resourceProfile, presetId, user.id);

    // 全てのステートメントをまとめる
    const allStmts = [deleteStmt, updatePresetStmt, ...stmts];

    // トランザクションバッチ実行 (変数上限回避のためチャンク分け)
    const batchChunkSize = 20;
    for (let i = 0; i < allStmts.length; i += batchChunkSize) {
      const chunk = allStmts.slice(i, i + batchChunkSize);
      await db.batch(chunk);
    }

    // 更新後の全MOD（手動＆前提＆軽量化）をロードして返却
    const { results: finalMods } = await db.prepare(`
      SELECT m.*, pm.manually_added 
      FROM preset_mods pm 
      JOIN mods m ON pm.mod_id = m.id 
      WHERE pm.preset_id = ?
    `).bind(presetId).all();

    const server_mods = finalMods.filter((m: any) => m.is_server_side === 1);
    const client_mods = finalMods.filter((m: any) => m.is_client_side === 1);

    return c.json({
      ok: true,
      estimated_load: estimatedLoad,
      resource_profile: resourceProfile,
      mods: finalMods,
      server_mods,
      client_mods,
      message: 'Preset mods updated and dependencies recalculated successfully'
    });

  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// DELETE /api/presets/:id - プリセットを削除 (関連する停止済みセッションも削除)
presetsApp.delete('/:id', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const id = c.req.param('id');
  
  try {
    // 1. 稼働中のセッションがないかチェック
    const activeSession = await db.prepare(
      'SELECT 1 FROM server_sessions WHERE preset_id = ? AND stopped_at IS NULL'
    ).bind(id).first();

    if (activeSession) {
      return c.json({ error: 'このプリセットは現在サーバーが起動中（または準備中）のため削除できません。停止してから再度お試しください。' }, 400);
    }

    // 2. 過去のセッション履歴を削除 (RESTRICT 制約回避のため先に削除)
    await db.prepare(
      'DELETE FROM server_sessions WHERE preset_id = ?'
    ).bind(id).run();

    // 3. プリセット本体の削除 (preset_mods も CASCADE される)
    const result = await db.prepare(
      'DELETE FROM presets WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Preset not found or not owned by user' }, 404);
    }

    return c.json({ ok: true, message: 'Preset deleted successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/presets/:id/resolve-missing - 不足している前提MOD（サーバー側・クライアント側）およびURL未解決MODをModrinth/CurseForgeから自動検索・補完
presetsApp.post('/:id/resolve-missing', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const presetId = c.req.param('id');

  try {
    const body = await c.req.json().catch(() => ({}));
    const requestedModIds: string[] = Array.isArray(body.missingModIds) ? body.missingModIds : [];

    // 1. プリセットの所有権と存在チェック
    const preset = await db.prepare(
      'SELECT id, name, mc_version, loader FROM presets WHERE id = ? AND user_id = ?'
    ).bind(presetId, user.id).first<any>();

    if (!preset) {
      return c.json({ error: 'Preset not found' }, 404);
    }

    // 2. 現在のプリセットに含まれる全MODを取得
    const { results: currentMods } = await db.prepare(`
      SELECT m.*, pm.manually_added
      FROM preset_mods pm
      JOIN mods m ON pm.mod_id = m.id
      WHERE pm.preset_id = ?
    `).bind(presetId).all<any>();

    const cfApiKey = c.env.CURSEFORGE_API_KEY || '';
    const stmts: D1PreparedStatement[] = [];
    const resolvedMods: Array<{ modId: string; name: string; action: 'added' | 'url_resolved'; downloadUrl: string }> = [];
    const unresolvedModIds: string[] = [];
    const failedSearchModIds: string[] = [];

    // A. 既存MODの download_url 解決
    const resolvedExistingIds = new Set<string>();
    const targetExistingMods = currentMods.filter((m: any) => {
      const extId = String(m.external_id || '');
      const isLocalJar = extId.startsWith('local:') || extId.startsWith('local-');
      const hasUrl = Boolean(m.download_url && m.download_url.trim() !== '');
      if (hasUrl) return false;
      if (!isLocalJar) return true;
      // ローカルJARでも requestedModIds に指定されている場合は検索対象に含める
      if (requestedModIds.length > 0) {
        const normName = String(m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const normExt = extId.toLowerCase().replace(/^local[:-]/, '').replace(/[^a-z0-9]/g, '');
        return requestedModIds.some(req => {
          const r = req.trim().toLowerCase();
          const rAlpha = r.replace(/[^a-z0-9]/g, '');
          const alias = (KNOWN_MOD_ALIASES[r] || KNOWN_MOD_ALIASES[rAlpha] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return rAlpha === normName || rAlpha === normExt || (alias && (alias === normName || alias === normExt));
        });
      }
      return false;
    }).slice(0, 35);

    for (const existing of targetExistingMods) {
      let foundUrl = '';
      let foundExternalId = String(existing.external_id || '');
      let foundSource: 'modrinth' | 'curseforge' = existing.source === 'curseforge' ? 'curseforge' : 'modrinth';

      try {
        if (foundExternalId && !foundExternalId.startsWith('local:') && !foundExternalId.startsWith('local-')) {
          foundUrl = await modClient.resolveDownloadUrl(
            foundSource,
            foundExternalId,
            preset.mc_version,
            preset.loader,
            cfApiKey
          );
        }

        if (!foundUrl) {
          const rawSlug = foundExternalId.replace(/^local[:-]/, '');
          const normSlug = rawSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
          const aliasQuery = KNOWN_MOD_ALIASES[rawSlug.toLowerCase()] || KNOWN_MOD_ALIASES[normSlug] || '';
          const query = aliasQuery || existing.name || rawSlug;
          const searchRes = await modClient.searchMods(query, preset.mc_version, preset.loader, cfApiKey);
          if (searchRes.length > 0) {
            const bestMatch = searchRes.find(
              (r) =>
                r.id.toLowerCase() === rawSlug.toLowerCase() ||
                r.slug.toLowerCase() === rawSlug.toLowerCase() ||
                r.title.toLowerCase() === String(existing.name).toLowerCase() ||
                r.title.toLowerCase().replace(/\s+/g, '') === rawSlug.toLowerCase().replace(/[-_]/g, '')
            ) || searchRes[0];

            const targetSource = bestMatch.source === 'curseforge' ? 'curseforge' : 'modrinth';
            const url = bestMatch.download_url || await modClient.resolveDownloadUrl(
              targetSource,
              bestMatch.id,
              preset.mc_version,
              preset.loader,
              cfApiKey
            );
            if (url) {
              foundUrl = url;
              foundExternalId = bestMatch.id;
              foundSource = targetSource;
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to resolve download URL for existing mod ${existing.name}:`, err);
      }

      if (foundUrl) {
        resolvedExistingIds.add(existing.id);
        stmts.push(
          db.prepare(
            'UPDATE mods SET download_url = ?, source = ?, external_id = ? WHERE id = ?'
          ).bind(foundUrl, foundSource, foundExternalId, existing.id)
        );
        resolvedMods.push({
          modId: String(existing.external_id || existing.name).replace(/^local[:-]/, ''),
          name: existing.name,
          action: 'url_resolved',
          downloadUrl: foundUrl,
        });
      }
    }

    // B. requestedModIds（サンドボックス診断で不足と判定された前提MOD ID）を検索・追加
    // ※ download_url が解決済みのMODのみを「解決済み既存MOD」として扱う
    const existingResolvedSlugs = new Set(
      currentMods
        .filter((m: any) => Boolean(m.download_url && m.download_url.trim() !== '') || resolvedExistingIds.has(m.id))
        .flatMap((m: any) => {
          const ext = String(m.external_id || '').toLowerCase();
          const extClean = ext.replace(/^local[:-]/, '');
          const name = String(m.name || '').toLowerCase();
          return [
            ext,
            extClean,
            extClean.replace(/[^a-z0-9]/g, ''),
            name,
            name.replace(/\s+/g, ''),
            name.replace(/[^a-z0-9]/g, ''),
          ];
        })
    );

    for (const rawMissingId of requestedModIds) {
      const normalized = rawMissingId.trim().toLowerCase();
      if (!normalized) continue;
      const normAlpha = normalized.replace(/[^a-z0-9]/g, '');

      // Fabric API の内蔵サブモジュール（fabric-resource-loader-v0, fabric-key-binding-api-v1, fabric-lifecycle-events-v1 等）が
      // 要求された場合は、単体MODではないため Forge なら Forgified Fabric API、Fabric なら Fabric API にマッピングする
      const isFabricSubmodule =
        (normalized.startsWith('fabric-') || normalized.startsWith('fabric_')) &&
        (normalized.includes('-v0') ||
          normalized.includes('-v1') ||
          normalized.includes('-v2') ||
          normalized.includes('api-base') ||
          normalized.includes('resource-loader') ||
          normalized.includes('lifecycle-events') ||
          normalized.includes('key-binding'));

      if (isFabricSubmodule) {
        const hasFabricApiInPreset = currentMods.some((m: any) => {
          const n = String(m.name || '').toLowerCase();
          const e = String(m.external_id || '').toLowerCase();
          return n.includes('fabric api') || e === '889079' || e === '306612' || e === 'p7drr8m2';
        });
        if (hasFabricApiInPreset) {
          resolvedMods.push({
            modId: rawMissingId,
            name: 'Forgified Fabric API / Fabric API (内蔵サブモジュール)',
            action: 'url_resolved',
            downloadUrl: '',
          });
          continue;
        }
      }

      const aliasName = isFabricSubmodule
        ? (preset.loader === 'forge' || preset.loader === 'neoforge' ? 'Forgified Fabric API' : 'Fabric API')
        : (KNOWN_MOD_ALIASES[normalized] || KNOWN_MOD_ALIASES[normAlpha] || '');
      const aliasAlpha = aliasName ? aliasName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

      // 既にプリセット内に download_url 解決済みの同名MODが存在するか確認
      const alreadyResolvedInPreset =
        existingResolvedSlugs.has(normalized) ||
        existingResolvedSlugs.has(normAlpha) ||
        (aliasAlpha && existingResolvedSlugs.has(aliasAlpha)) ||
        Array.from(existingResolvedSlugs).some(s => s.length >= 4 && (s.includes(normAlpha) || normAlpha.includes(s)));

      if (alreadyResolvedInPreset) {
        const matchedExisting = currentMods.find((m: any) => {
          const n = String(m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const e = String(m.external_id || '').toLowerCase().replace(/^local[:-]/, '').replace(/[^a-z0-9]/g, '');
          return n === normAlpha || e === normAlpha || (aliasAlpha && (n === aliasAlpha || e === aliasAlpha));
        });
        if (matchedExisting && !resolvedMods.some(r => r.name === matchedExisting.name)) {
          resolvedMods.push({
            modId: rawMissingId,
            name: matchedExisting.name,
            action: 'url_resolved',
            downloadUrl: matchedExisting.download_url || '',
          });
        }
        continue;
      }

      let resolved = false;
      try {
        const searchQuery = aliasName || rawMissingId.replace(/[_-]+/g, ' ').trim();
        const searchRes = await modClient.searchMods(searchQuery, preset.mc_version, preset.loader, cfApiKey);
        if (searchRes.length > 0) {
          const candidate = searchRes[0];
          const targetSource = candidate.source === 'curseforge' ? 'curseforge' : 'modrinth';
          const downloadUrl = candidate.download_url || await modClient.resolveDownloadUrl(
            targetSource,
            candidate.id,
            preset.mc_version,
            preset.loader,
            cfApiKey
          );

          if (downloadUrl) {
            // 既に mods テーブルに存在するか確認
            const existingDbMod = await db.prepare(
              'SELECT id FROM mods WHERE source = ? AND external_id = ? AND mc_version = ? AND (loader = ? OR loader = \'any\')'
            ).bind(targetSource, candidate.id, preset.mc_version, preset.loader).first<any>();

            const newModUuid = existingDbMod ? existingDbMod.id : crypto.randomUUID();
            const isServer = candidate.server_side === 'unsupported' ? 0 : 1;
            const isClient = candidate.client_side === 'unsupported' ? 0 : 1;

            if (!existingDbMod) {
              stmts.push(
                db.prepare(`
                  INSERT OR IGNORE INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `).bind(
                  newModUuid,
                  targetSource,
                  candidate.id,
                  candidate.title,
                  preset.mc_version,
                  preset.loader,
                  candidate.license || 'Unknown',
                  downloadUrl,
                  isServer,
                  isClient
                )
              );
            } else {
              stmts.push(
                db.prepare('UPDATE mods SET download_url = ? WHERE id = ?').bind(downloadUrl, newModUuid)
              );
            }

            stmts.push(
              db.prepare(`
                INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added)
                VALUES (?, ?, 0)
              `).bind(presetId, newModUuid)
            );

            existingResolvedSlugs.add(normalized);
            existingResolvedSlugs.add(candidate.id.toLowerCase());
            resolvedMods.push({
              modId: rawMissingId,
              name: candidate.title,
              action: 'added',
              downloadUrl,
            });
            resolved = true;
          }
        }
      } catch (err) {
        console.warn(`Failed to search/resolve missing modId ${rawMissingId}:`, err);
      }

      if (!resolved) {
        if (!failedSearchModIds.includes(rawMissingId)) {
          failedSearchModIds.push(rawMissingId);
        }
        // Modrinth/CurseForge で直接URLが見つからない場合でも、ローカル(.minecraft/mods や CurseForge インスタンス)にJARが存在するケースに対応するためプリセット構成に登録する
        const localExtId = `local:${normalized}`;
        const displayTitle = KNOWN_MOD_ALIASES[normalized] || KNOWN_MOD_ALIASES[normAlpha] || rawMissingId.replace(/[_-]+/g, ' ').trim();
        const existingLocalMod = await db.prepare(
          'SELECT id FROM mods WHERE external_id = ? AND mc_version = ? AND (loader = ? OR loader = \'any\')'
        ).bind(localExtId, preset.mc_version, preset.loader).first<any>();

        const localModUuid = existingLocalMod ? existingLocalMod.id : crypto.randomUUID();
        if (!existingLocalMod) {
          stmts.push(
            db.prepare(`
              INSERT OR IGNORE INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
              VALUES (?, 'manual', ?, ?, ?, ?, 'Custom JAR', '', 1, 1, 0)
            `).bind(localModUuid, localExtId, displayTitle, preset.mc_version, preset.loader)
          );
        }
        stmts.push(
          db.prepare(`
            INSERT OR IGNORE INTO preset_mods (preset_id, mod_id, manually_added)
            VALUES (?, ?, 0)
          `).bind(presetId, localModUuid)
        );
      }
    }

    if (stmts.length > 0) {
      stmts.push(
        db.prepare("UPDATE presets SET updated_at = datetime('now') WHERE id = ?").bind(presetId)
      );
      const batchChunkSize = 20;
      for (let i = 0; i < stmts.length; i += batchChunkSize) {
        await db.batch(stmts.slice(i, i + batchChunkSize));
      }
    }

    // 更新後のMOD一覧を再取得
    const { results: finalMods } = await db.prepare(`
      SELECT m.*, pm.manually_added
      FROM preset_mods pm
      JOIN mods m ON pm.mod_id = m.id
      WHERE pm.preset_id = ?
    `).bind(presetId).all<any>();

    return c.json({
      ok: true,
      resolvedMods,
      unresolvedModIds,
      failedSearchModIds,
      mods: finalMods,
      server_mods: finalMods.filter((m: any) => m.is_server_side === 1),
      client_mods: finalMods.filter((m: any) => m.is_client_side === 1),
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default presetsApp;
