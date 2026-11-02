import { Hono } from 'hono';
import { Bindings } from '../index';
import { appSettingsSchema } from '@msiaas/shared';

const settingsApp = new Hono<{ Bindings: Bindings, Variables: { user: any } }>();

// GET /api/settings - 設定情報を取得
settingsApp.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    // コンテキストのユーザー情報が古い可能性があるので、DBから最新のユーザー情報を取得
    const latestUser = await db.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(user.id).first<any>();

    const u = latestUser || user;

    return c.json({
      settings: {
        minecraftUuid: u.minecraft_uuid || null,
        javaPath: u.java_path || null,
        defaultMemoryGb: u.default_memory_gb ?? 4,
        usePlayitGg: u.use_playit_gg === undefined ? true : !!u.use_playit_gg,
        pvp: u.pvp === undefined ? true : !!u.pvp,
        difficulty: u.difficulty || 'easy',
        gamemode: u.gamemode || 'survival',
        maxPlayers: u.max_players ?? 20,
        allowFlight: !!u.allow_flight,
        whiteList: !!u.white_list,
        viewDistance: u.view_distance ?? 6,
        motd: u.motd || 'MSIaaS Local Server',
      }
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// PUT /api/settings - 設定情報を更新
settingsApp.put('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    const body = await c.req.json();
    const result = appSettingsSchema.safeParse(body);

    if (!result.success) {
      return c.json({ error: 'Invalid settings format.', details: result.error.errors }, 400);
    }

    const val = result.data;

    await db.prepare(`
      UPDATE users
      SET minecraft_uuid = ?,
          java_path = ?,
          default_memory_gb = ?,
          use_playit_gg = ?,
          pvp = ?,
          difficulty = ?,
          gamemode = ?,
          max_players = ?,
          allow_flight = ?,
          white_list = ?,
          view_distance = ?,
          motd = ?,
          updated_at = (datetime('now'))
      WHERE id = ?
    `).bind(
      val.minecraftUuid || null,
      val.javaPath || null,
      val.defaultMemoryGb,
      val.usePlayitGg ? 1 : 0,
      val.pvp ? 1 : 0,
      val.difficulty,
      val.gamemode,
      val.maxPlayers,
      val.allowFlight ? 1 : 0,
      val.whiteList ? 1 : 0,
      val.viewDistance,
      val.motd,
      user.id
    ).run();

    return c.json({ ok: true, message: 'Settings updated successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default settingsApp;
