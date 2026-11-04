import { CloudManager } from '@msiaas/cloud-provider';
import { ModDbClient } from '@msiaas/mod-db-tools';

export async function scheduledHandler(event: ScheduledEvent, env: any, ctx: ExecutionContext) {
  const db = env.DB as D1Database;
  const cloudManager = new CloudManager();
  const modClient = new ModDbClient();

  switch (event.cron) {
    case '0 3 * * *': // 毎日UTC 03:00
      console.log('[Cron] Running daily Modrinth cache update...');
      await modClient.updateCache();
      break;

    case '*/5 * * * *': // 5分ごと
      console.log('[Cron] Checking for absentee servers to terminate...');
      const { results: activeSessions } = await db.prepare(
        "SELECT id, instance_id, status, empty_since_at, current_player_count FROM server_sessions WHERE status IN ('running', 'warning_sent')"
      ).all();

      const now = new Date();
      const nowIso = now.toISOString();

      for (const session of activeSessions) {
        if (!session.instance_id) continue;

        const playerCount = session.current_player_count as number;
        const currentStatus = session.status as string;

        if (playerCount > 0) {
          if (session.empty_since_at || currentStatus === 'warning_sent') {
            console.log(`[Cron] Session ${session.id} is active again. Resetting empty tracker.`);
          }

          const nextStatus = currentStatus === 'warning_sent' ? 'running' : currentStatus;

          await db.prepare("UPDATE server_sessions SET empty_since_at = NULL, status = ? WHERE id = ?")
            .bind(nextStatus, session.id)
            .run();

          if (currentStatus === 'warning_sent') {
            await db.prepare(
              "INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)"
            )
              .bind(session.id, 'warning_sent', 'running', 'player_returned', 'player_returned', nowIso)
              .run();
          }
          continue;
        }

        let emptySinceStr = session.empty_since_at as string | null;

        if (!emptySinceStr) {
          emptySinceStr = nowIso;
          console.log(`[Cron] Session ${session.id} is now empty. Starting inactive tracker.`);
          await db.prepare("UPDATE server_sessions SET empty_since_at = ? WHERE id = ?")
            .bind(emptySinceStr, session.id)
            .run();
        }

        const emptySince = new Date(emptySinceStr);
        const diffMinutes = Math.floor((now.getTime() - emptySince.getTime()) / 60000);

        if (diffMinutes >= 20) {
          console.log(`[Cron] Session ${session.id} inactive for ${diffMinutes}m (>= 20m). Terminating...`);
          try {
            await cloudManager.terminate(session.instance_id as string);

            await db.prepare("UPDATE server_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?")
              .bind(nowIso, session.id)
              .run();

            await db.prepare(
              'INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)'
            )
              .bind(session.id, currentStatus, 'stopped', 'player_empty', 'player_empty', nowIso)
              .run();
          } catch (e: any) {
            console.error(`[Cron] Failed to terminate session ${session.id}: ${e.message}`);
          }
        } else if (diffMinutes >= 15 && currentStatus === 'running') {
          const remaining = 20 - diffMinutes;
          console.log(`[Cron] Session ${session.id} inactive for ${diffMinutes}m. Sending warning... (${remaining}m)`);

          await db.prepare("UPDATE server_sessions SET status = 'warning_sent' WHERE id = ?")
            .bind(session.id)
            .run();

          await db.prepare(
            'INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
            .bind(session.id, 'running', 'warning_sent', 'inactive_15m', 'inactive_15m', nowIso)
            .run();
        }
      }
      break;

    default:
      console.log(`[Cron] Unknown cron schedule: ${event.cron}`);
  }
}
