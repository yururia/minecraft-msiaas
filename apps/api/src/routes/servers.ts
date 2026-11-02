import { Hono } from 'hono';
import { Bindings } from '../index';
import { CloudManager } from '@msiaas/cloud-provider';
import { ServerSessionResponse } from '@msiaas/shared';

const serversApp = new Hono<{ Bindings: Bindings, Variables: { user: any } }>();
const cloudManager = new CloudManager();

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
    // 1. アクティブなセッションを1件取得
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

    // 2. そのセッションに関連する状態遷移ログを取得 (古い順にソート)
    const { results: logs } = await db.prepare(`
      SELECT * FROM server_status_logs
      WHERE session_id = ?
      ORDER BY transitioned_at ASC
    `).bind(session.id).all();

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
    const body = await c.req.json();
    const { presetId } = body;

    if (!presetId) {
      return c.json({ error: 'Preset ID is required.' }, 400);
    }

    // 1. すでにアクティブなセッションがある場合は自動的に終了済みに更新してリセット
    const activeSessions = await db.prepare(`
      SELECT id FROM server_sessions
      WHERE user_id = ? AND stopped_at IS NULL
    `).bind(user.id).all();

    const nowDate = new Date();
    const now = nowDate.toISOString();

    if (activeSessions.results && activeSessions.results.length > 0) {
      for (const s of activeSessions.results as any[]) {
        await db.prepare(`
          UPDATE server_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
        `).bind(now, s.id).run();
        await db.prepare(`
          INSERT INTO server_status_logs (session_id, from_status, to_status, reason, transitioned_at)
          VALUES (?, 'unknown', 'stopped', 'Auto-closed prior session for new launch', ?)
        `).bind(s.id, now).run();
      }
    }

    // 2. プリセットが存在するか、そしてそのユーザーのものかチェック
    const preset = await db.prepare(`
      SELECT id FROM presets WHERE id = ? AND user_id = ?
    `).bind(presetId, user.id).first();

    if (!preset) {
      return c.json({ error: 'Preset not found.' }, 404);
    }

    // 2.5. 起動回数のカウント更新（起動上限は撤廃・無制限）
    await db.prepare(`
      UPDATE users SET server_launch_count_1h = COALESCE(server_launch_count_1h, 0) + 1, last_launch_reset_at = ? WHERE id = ?
    `).bind(now, user.id).run();

    // 3. server_sessions テーブルに status = 'queued' でレコードをインサート
    const sessionId = crypto.randomUUID();
    
    await db.prepare(`
      INSERT INTO server_sessions (id, user_id, preset_id, status, started_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).bind(sessionId, user.id, presetId, now).run();

    // 4. server_status_logs テーブルに初期状態を記録
    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, transitioned_at)
      VALUES (?, NULL, 'queued', 'User triggered server launch', ?)
    `).bind(sessionId, now).run();

    // 5. PROVISIONING_QUEUE にメッセージを送信 (Tauriローカル起動の場合はNext.js側がTauri Rust APIを呼ぶため、クラウド版のキュー送信は不要ですが、非Tauri/本番用に残します)
    const isDev = (c.env as any).ENVIRONMENT === 'dev';
    if (!isDev) {
      await c.env.PROVISIONING_QUEUE.send({
        presetId,
        userId: user.id
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
    // 1. アクティブなセッションを取得
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

    // 2. セッションの status を 'stopping' に更新し、ログを記録
    await db.prepare(`
      UPDATE server_sessions
      SET status = 'stopping'
      WHERE id = ?
    `).bind(sessionId).run();

    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, transitioned_at)
      VALUES (?, ?, 'stopping', 'User requested server shutdown', ?)
    `).bind(sessionId, activeSession.status, now).run();

    // 3. インスタンスIDがあれば破棄を実行
    if (activeSession.instance_id) {
      try {
        await cloudManager.terminate(activeSession.instance_id as string);
      } catch (err: any) {
        console.error(`[API] CloudManager terminate failed: ${err.message}`);
      }
    }

    // 4. 停止完了（stopped）にする
    await db.prepare(`
      UPDATE server_sessions
      SET status = 'stopped', stopped_at = ?
      WHERE id = ?
    `).bind(now, sessionId).run();

    await db.prepare(`
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, transitioned_at)
      VALUES (?, 'stopping', 'stopped', 'Server stopped successfully', ?)
    `).bind(sessionId, now).run();

    return c.json({ message: 'Server shutdown completed successfully' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// GET /api/servers/active/mods - 起動中サーバーの全MOD一括返却（同期MOD用）
serversApp.get('/active/mods', async (c) => {
  const db = c.env.DB;
  
  try {
    // 1. アクティブなセッションを1件取得
    const session = await db.prepare(`
      SELECT preset_id, status FROM server_sessions
      WHERE stopped_at IS NULL AND status IN ('running', 'provisioning', 'queued')
      LIMIT 1
    `).first();

    if (!session) {
      return c.json({ error: 'No active server session found.' }, 404);
    }

    // 2. そのセッションのプリセットに関連する全MOD（ユーザー追加 ＆ 前提自動追加含む）とダウンロードURL・Side判定フラグを取得
    const { results: mods } = await db.prepare(`
      SELECT m.id, m.name, m.source, m.external_id, m.download_url, m.mc_version, m.loader, m.is_server_side, m.is_client_side, pm.manually_added
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
  
  try {
    const { sessionId, status, ipAddress, instanceId, cloudProvider, javaPid, serverDataDir, reason } = await c.req.json();

    if (!sessionId) {
      return c.json({ error: 'Session ID is required.' }, 400);
    }

    const now = new Date().toISOString();
    const current = await db.prepare(
      'SELECT status FROM server_sessions WHERE id = ?'
    ).bind(sessionId).first<any>();

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
      INSERT INTO server_status_logs (session_id, from_status, to_status, reason, transitioned_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(sessionId, current?.status || null, status, logReason, now).run();

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default serversApp;

