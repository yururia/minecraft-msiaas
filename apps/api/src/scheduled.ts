import { CloudManager } from '@msiaas/cloud-provider';
import { ModDbClient } from '@msiaas/mod-db-tools';

export async function scheduledHandler(event: ScheduledEvent, env: any, ctx: ExecutionContext) {
  const db = env.DB as D1Database;
  const cloudManager = new CloudManager();
  const modClient = new ModDbClient();

  switch (event.cron) {
    case '0 3 * * *': // 毎日UTC 03:00 (日本時間 12:00)
      console.log('[Cron] Running daily Modrinth cache update...');
      await modClient.updateCache();
      break;

    case '*/5 * * * *': // 5分ごと
      console.log('[Cron] Checking for absentee servers to terminate...');
      // 1. 稼働中または警告送信済みのサーバーを取得
      const { results: activeSessions } = await db.prepare(
        "SELECT id, instance_id, status, empty_since_at, current_player_count FROM server_sessions WHERE status IN ('running', 'warning_sent') AND stopped_at IS NULL"
      ).all();

      const now = new Date();

      for (const session of activeSessions) {
        if (!session.instance_id) continue;

        // DBに記録されているプレイヤー数を基準にする
        const playerCount = session.current_player_count as number;
        const currentStatus = session.status as string;

        if (playerCount > 0) {
          // プレイヤーがいる場合：無人検知時刻をリセット
          if (session.empty_since_at || currentStatus === 'warning_sent') {
            console.log(`[Cron] Session ${session.id} is active again. Resetting empty tracker.`);
            
            // ステータスが warning_sent だった場合は running に戻す
            const nextStatus = currentStatus === 'warning_sent' ? 'running' : currentStatus;
            
            await db.prepare("UPDATE server_sessions SET empty_since_at = NULL, status = ? WHERE id = ?")
              .bind(nextStatus, session.id)
              .run();

            if (currentStatus === 'warning_sent') {
              await db.prepare(
                'INSERT INTO server_status_logs (session_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
              )
              .bind(session.id, 'warning_sent', 'running', 'player_returned')
              .run();
            }
          }
          continue;
        }

        // プレイヤーが0人の場合の処理
        let emptySinceStr = session.empty_since_at as string | null;
        
        if (!emptySinceStr) {
          // 初めてプレイヤーが0人になったとき：現在時刻を記録
          emptySinceStr = now.toISOString();
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
              .bind(now.toISOString(), session.id)
              .run();

            await db.prepare(
              'INSERT INTO server_status_logs (session_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
            )
            .bind(session.id, currentStatus, 'stopped', 'player_empty')
            .run();
          } catch (e: any) {
            console.error(`[Cron] Failed to terminate session ${session.id}: ${e.message}`);
          }
        } else if (diffMinutes >= 15 && currentStatus === 'running') {
          // 15分経過し、まだ警告を出していない場合：警告フェーズへ移行
          const remaining = 20 - diffMinutes;
          console.log(`[Cron] Session ${session.id} inactive for ${diffMinutes}m. Sending warning... (${remaining}m left)`);
          
          await db.prepare("UPDATE server_sessions SET status = 'warning_sent' WHERE id = ?")
            .bind(session.id)
            .run();

          await db.prepare(
            'INSERT INTO server_status_logs (session_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
          )
          .bind(session.id, 'running', 'warning_sent', 'inactive_15m')
          .run();

          // TODO: RCON経由でサーバー内に警告メッセージ "Server will shut down in ${remaining} minutes." を送信する
        }
      }
      break;
      
    default:
      console.log(`[Cron] Unknown cron schedule: ${event.cron}`);
  }
}
