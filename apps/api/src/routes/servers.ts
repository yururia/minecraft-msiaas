import { Hono } from 'hono';
import { z } from 'zod';
import { Bindings, Variables } from '../index';
import { CloudManager } from '@msiaas/cloud-provider';
import { ServerSessionResponse } from '@msiaas/shared';

const serversApp = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const cloudManager = new CloudManager();

const launchSchema = z.object({
  presetId: z.string().min(1, 'Preset ID is required.'),
  cloudProvider: z.enum(['local', 'oracle', 'aws']).optional(),
});

const sessionUpdateSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required.'),
  status: z.enum([
    'queued',
    'provisioning',
    'fallback',
    'running',
    'warning_sent',
    'stopping',
    'stopped',
    'failed',
  ]),
  ipAddress: z.string().nullable().optional(),
  instanceId: z.string().nullable().optional(),
  cloudProvider: z.enum(['local', 'oracle', 'aws']).optional(),
  javaPid: z.number().int().positive().nullable().optional(),
  serverDataDir: z.string().nullable().optional(),
  reason: z.string().max(255).optional(),
});

function mapSessionToResponse(session: any): ServerSessionResponse {
  let providerInfo = 'PROVISIONING...';
  if (session.cloud_provider === 'local') {
    providerInfo = '🖥️ ローカルサーバー (Java直起動)';
  } else if (session.cloud_provider === 'oracle') {
    providerInfo = '☁️ Oracle Cloud';
  } else if (session.cloud_provider === 'aws') {
    providerInfo = '☁️ AWS';
  }

  return {
    id: session.id,
    status: session.status,
    connectionAddress: session.ip_address || null,
    mcVersion: session.mc_version,
    loader: session.loader,
    presetName: session.preset_name,
    startedAt: session.started_at,
    stoppedAt: session.stopped_at || null,
    diskUsedMb: session.disk_used_mb || 0,
    currentPlayerCount: session.current_player_count || 0,
    providerInfo,
  };
}

// GET /api/servers/active - 現在のアクティブセッション情報と対応する server_status_logs を取得
serversApp.get('/active', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    const session = await db.prepare(`
      SELECT s.*, p.name as preset_name, p.mc_version, p.loader, p.resource_profile
      FROM server_sessions s
      JOIN presets p ON s.preset_id = p.id
      WHERE s.user_id = ? AND s.stopped_at IS NULL
      LIMIT 1
    `).bind(user.id).first();

    if (!session) {
      return c.json({ session: null, logs: [] });
    }

    let logs: any[] = [];
    try {
      const res = await db.prepare(`
        SELECT id, session_id, from_status, to_status, COALESCE(reason, detail) as reason, detail, transitioned_at, created_at
        FROM server_status_logs
        WHERE session_id = ?
        ORDER BY transitioned_at ASC, created_at ASC
      `).bind(session.id).all();
      logs = res.results || [];
    } catch {
      const res = await db.prepare(`
        SELECT id, session_id, from_status, to_status, reason, reason as detail, transitioned_at, transitioned_at as created_at
        FROM server_status_logs
        WHERE session_id = ?
        ORDER BY transitioned_at ASC
      `).bind(session.id).all();
      logs = res.results || [];
    }

    return c.json({ session: mapSessionToResponse(session), logs });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/servers/launch - 指定したプリセットIDのサーバープロビジョニングジョブを PROVISIONING_QUEUE に投入
serversApp.post('/launch', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    const rawBody = await c.req.json();
    const parsed = launchSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Preset ID is required.' }, 400);
    }
    const { presetId, cloudProvider } = parsed.data;
    const isLocalProvider = cloudProvider === 'local';

    // 1. すでにアクティブなセッションがある場合は自動的に終了済みに更新してリセット
    const activeSessions = await db.prepare(`
      SELECT id, status, instance_id FROM server_sessions
      WHERE user_id = ? AND stopped_at IS NULL
    `).bind(user.id).all();

    const now = new Date().toISOString();

    if (activeSessions.results && activeSessions.results.length > 0) {
      for (const s of activeSessions.results as any[]) {
        if (s.instance_id) {
          try {
            await cloudManager.terminate(s.instance_id as string);
          } catch (termErr: any) {
            console.error(`[API] Failed to terminate prior instance ${s.instance_id}: ${termErr.message}`);
          }
        }
        await db.prepare(`
          UPDATE server_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
        `).bind(now, s.id).run();
        await db.prepare(`
          INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at)
          VALUES (?, ?, 'stopped', 'Auto-closed prior session for new launch', 'Auto-closed prior session for new launch', ?)
        `).bind(s.id, s.status || 'unknown', now).run();
      }
    }

    // 2. プリセットが存在し、そのユーザーのものかチェック
    const preset = await db.prepare(`
      SELECT id FROM presets WHERE id = ? AND user_id = ?
    `).bind(presetId, user.id).first();

    if (!preset) {
      return c.json({ error: 'Preset not found.' }, 404);
    }

    // 2.5. レートリミット判定・更新（クラウド起動時のみ1時間あたり最大3回まで制限、ローカルJava起動時は無制限）
    if (isLocalProvider) {
      await db.prepare(`
        UPDATE users
        SET server_launch_count_1h = COALESCE(server_launch_count_1h, 0) + 1
        WHERE id = ?
      `).bind(user.id).run();
    } else {
      const latestUser = await db.prepare(
        'SELECT server_launch_count_1h, last_launch_reset_at FROM users WHERE id = ?'
      ).bind(user.id).first<{ server_launch_count_1h: number; last_launch_reset_at: string | null }>();

      const currentCount = latestUser?.server_launch_count_1h ?? 0;
      const lastResetStr = latestUser?.last_launch_reset_at;
      const nowMs = Date.now();
      const lastResetMs = lastResetStr ? new Date(lastResetStr.includes('T') ? lastResetStr : `${lastResetStr.replace(' ', 'T')}Z`).getTime() : 0;
      const elapsedMs = nowMs - (isNaN(lastResetMs) ? 0 : lastResetMs);
      const oneHourMs = 60 * 60 * 1000;

      if (elapsedMs >= oneHourMs) {
        await db.prepare(`
          UPDATE users
          SET server_launch_count_1h = 1,
              last_launch_reset_at = ?
          WHERE id = ?
        `).bind(now, user.id).run();
      } else if (currentCount >= 3) {
        return c.json({
          error: '1時間あたりのクラウドサーバー起動上限（3回）に達しました。しばらく時間をおいてから再度お試しください。'
        }, 429);
      } else {
        await db.prepare(`
          UPDATE users
          SET server_launch_count_1h = COALESCE(server_launch_count_1h, 0) + 1
          WHERE id = ?
        `).bind(user.id).run();
      }
    }

    // 3. server_sessions テーブルに status = 'queued' でレコードをインサート
    const sessionId = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO server_sessions (id, user_id, preset_id, status, started_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).bind(sessionId, user.id, presetId, now).run();

    // 4. server_status_logs テーブルに初期状態を記録
    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at)
      VALUES (?, NULL, 'queued', 'User triggered server launch', 'User triggered server launch', ?)
    `).bind(sessionId, now).run();

    // 5. PROVISIONING_QUEUE にメッセージを送信
    const isDev = c.env?.ENVIRONMENT === 'dev';
    if (!isDev && c.env?.PROVISIONING_QUEUE) {
      await c.env.PROVISIONING_QUEUE.send({
        presetId,
        userId: user.id,
      });
    }

    // 6. 新規作成されたセッション情報を取得して返す
    const newSession = await db.prepare(`
      SELECT s.*, p.name as preset_name, p.mc_version, p.loader, p.resource_profile
      FROM server_sessions s
      JOIN presets p ON s.preset_id = p.id
      WHERE s.id = ?
    `).bind(sessionId).first();

    return c.json({ session: mapSessionToResponse(newSession), message: 'Server launch queued successfully' }, 202);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// POST /api/servers/stop - サーバーを停止
serversApp.post('/stop', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    const activeSession = await db.prepare(`
      SELECT * FROM server_sessions
      WHERE user_id = ? AND stopped_at IS NULL
      LIMIT 1
    `).bind(user.id).first();

    if (!activeSession) {
      return c.json({ error: 'No active server session found.' }, 404);
    }

    const sessionId = activeSession.id;
    const now = new Date().toISOString();

    await db.prepare(`
      UPDATE server_sessions
      SET status = 'stopping'
      WHERE id = ?
    `).bind(sessionId).run();

    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at)
      VALUES (?, ?, 'stopping', 'User requested server shutdown', 'User requested server shutdown', ?)
    `).bind(sessionId, activeSession.status, now).run();

    if (activeSession.instance_id) {
      try {
        await cloudManager.terminate(activeSession.instance_id as string);
      } catch (err: any) {
        console.error(`[API] CloudManager terminate failed: ${err.message}`);
      }
    }

    await db.prepare(`
      UPDATE server_sessions
      SET status = 'stopped', stopped_at = ?
      WHERE id = ?
    `).bind(now, sessionId).run();

    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at)
      VALUES (?, 'stopping', 'stopped', 'Server stopped successfully', 'Server stopped successfully', ?)
    `).bind(sessionId, now).run();

    return c.json({ message: 'Server shutdown completed successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/servers/active/mods - 起動中サーバーの全MOD一括返却 (同期MOD用)
serversApp.get('/active/mods', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const sessionIdQuery = c.req.query('session_id');

  try {
    let session: any = null;
    if (sessionIdQuery) {
      session = await db.prepare(`
        SELECT preset_id, status FROM server_sessions
        WHERE id = ? AND stopped_at IS NULL AND status IN ('running', 'provisioning', 'queued')
        LIMIT 1
      `).bind(sessionIdQuery).first();
    } else if (user?.id) {
      session = await db.prepare(`
        SELECT preset_id, status FROM server_sessions
        WHERE user_id = ? AND stopped_at IS NULL AND status IN ('running', 'provisioning', 'queued')
        LIMIT 1
      `).bind(user.id).first();
    } else {
      session = await db.prepare(`
        SELECT preset_id, status FROM server_sessions
        WHERE stopped_at IS NULL AND status IN ('running', 'provisioning', 'queued')
        LIMIT 1
      `).first();
    }

    if (!session) {
      return c.json({ error: 'No active server session found.' }, 404);
    }

    const { results: mods } = await db.prepare(`
      SELECT m.id, m.name, m.source, m.external_id, m.download_url, m.mc_version, m.loader, m.is_server_side, m.is_client_side
      FROM preset_mods pm
      JOIN mods m ON pm.mod_id = m.id
      WHERE pm.preset_id = ?
    `).bind(session.preset_id).all();

    return c.json({ mods });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// PUT /api/servers/session - Tauri Rust / Web UI からのセッション状態・PIDの更新受付
serversApp.put('/session', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');

  try {
    const rawBody = await c.req.json();
    const parsed = sessionUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Invalid session update payload.', details: parsed.error.issues }, 400);
    }

    const { sessionId, status, ipAddress, instanceId, cloudProvider, javaPid, serverDataDir, reason } = parsed.data;

    const current = await db.prepare(
      'SELECT id, user_id, status FROM server_sessions WHERE id = ?'
    ).bind(sessionId).first<any>();

    if (!current) {
      return c.json({ error: 'Session not found.' }, 404);
    }

    // Ownership verification when authenticated user is present
    if (user?.id && current.user_id !== user.id) {
      return c.json({ error: 'Forbidden: session belongs to another user.' }, 403);
    }

    const now = new Date().toISOString();

    await db.prepare(`
      UPDATE server_sessions
      SET status = ?, ip_address = ?, instance_id = ?, cloud_provider = ?, java_pid = ?, server_data_dir = ?,
          stopped_at = ?
      WHERE id = ?
    `).bind(
      status,
      ipAddress || null,
      instanceId || null,
      cloudProvider || 'local',
      javaPid || null,
      serverDataDir || null,
      status === 'stopped' || status === 'failed' ? now : null,
      sessionId
    ).run();

    const logReason = reason || 'Tauri local execution sync';
    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(sessionId, current.status || null, status, logReason, logReason, now).run();

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default serversApp;
