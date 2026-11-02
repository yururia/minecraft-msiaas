import { Hono } from 'hono';
import { Bindings } from '../index';
import { ModDbClient } from '@msiaas/mod-db-tools';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const modsApp = new Hono<{ Bindings: Bindings }>();
const modClient = new ModDbClient();

// GET /api/mods - 利用可能なMODの一覧を取得 (キャッシュDBから)
modsApp.get('/', async (c) => {
  const mcVersion = c.req.query('mc_version');
  const loader = c.req.query('loader');

  let query = 'SELECT * FROM mods WHERE 1=1';
  const params: string[] = [];

  if (mcVersion) {
    query += ' AND mc_version = ?';
    params.push(mcVersion);
  }
  if (loader) {
    query += ' AND (loader = ? OR loader = "any")';
    params.push(loader);
  }

  try {
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ mods: results });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/mods/search - リアルタイム公式API横断検索 [NEW]
modsApp.get('/search', async (c) => {
  const query = c.req.query('q') || '';
  const mcVersion = c.req.query('mc_version') || '1.20.1';
  const loader = c.req.query('loader') || 'forge';
  const apiKey = c.env.CURSEFORGE_API_KEY || '';

  try {
    const mods = await modClient.searchMods(query, mcVersion, loader, apiKey);
    return c.json({ mods });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/mods - 新しいMODデータをマスタDBにキャッシュ [NEW]
modsApp.post('/', zValidator('json', z.object({
  source: z.string(),
  external_id: z.string(),
  name: z.string(),
  mc_version: z.string(),
  loader: z.string(),
  license: z.string().optional(),
  download_url: z.string().optional(),
  client_side: z.string().optional(),
  server_side: z.string().optional(),
  is_server_side: z.union([z.number(), z.boolean()]).optional(),
  is_client_side: z.union([z.number(), z.boolean()]).optional(),
})), async (c) => {
  const body = c.req.valid('json');
  const db = c.env.DB;

  try {
    const isServerSide = body.is_server_side !== undefined
      ? (body.is_server_side ? 1 : 0)
      : (body.server_side === 'unsupported' ? 0 : 1);
    const isClientSide = body.is_client_side !== undefined
      ? (body.is_client_side ? 1 : 0)
      : (body.client_side === 'unsupported' ? 0 : 1);

    let resolvedDownloadUrl = body.download_url || '';
    if (!resolvedDownloadUrl && (body.source === 'modrinth' || body.source === 'curseforge') && !body.external_id.startsWith('local:')) {
      resolvedDownloadUrl = await modClient.resolveDownloadUrl(
        body.source,
        body.external_id,
        body.mc_version,
        body.loader,
        c.env.CURSEFORGE_API_KEY
      );
    }

    // 既存チェック
    const existing = await db.prepare(
      'SELECT id, download_url FROM mods WHERE external_id = ? AND mc_version = ? AND (loader = ? OR loader = "any") AND source = ?'
    ).bind(body.external_id, body.mc_version, body.loader, body.source).first<{ id: string; download_url: string | null }>();

    if (existing) {
      // 既存レコードの side 情報や download_url を最新状態に更新
      await db.prepare(`
        UPDATE mods
        SET is_server_side = ?, is_client_side = ?, download_url = COALESCE(NULLIF(?, ''), download_url)
        WHERE id = ?
      `).bind(isServerSide, isClientSide, resolvedDownloadUrl, existing.id).run();
      return c.json({ id: existing.id });
    }

    // 新規登録
    const newId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO mods (id, source, external_id, name, mc_version, loader, license, download_url, is_server_side, is_client_side, is_lightweight_pack)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      newId,
      body.source,
      body.external_id,
      body.name,
      body.mc_version,
      body.loader,
      body.license || 'Unknown',
      resolvedDownloadUrl,
      isServerSide,
      isClientSide
    ).run();

    return c.json({ id: newId }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default modsApp;
