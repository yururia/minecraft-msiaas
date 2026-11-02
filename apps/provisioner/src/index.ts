import { CloudManager } from '@msiaas/cloud-provider';

export interface Env {
  DB: D1Database;
}

export type ProvisionMessage = {
  presetId: string;
  userId: string;
};

const cloudManager = new CloudManager();

export default {
  /**
   * Cloudflare Queues のコンシューマー (イベントリスナー)
   * APIアプリなどからメッセージが送信されると自動的にトリガーされます。
   */
  async queue(batch: MessageBatch<ProvisionMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { presetId, userId } = msg.body;
      console.log(`[Provisioner] Received request to provision preset ${presetId} for user ${userId}`);

      try {
        // 1. D1 データベースで、現在 'queued' になっているこのユーザーのセッションを探す
        const existingSession = await env.DB.prepare(
          'SELECT id FROM server_sessions WHERE user_id = ? AND preset_id = ? AND status = ? AND stopped_at IS NULL LIMIT 1'
        )
        .bind(userId, presetId, 'queued')
        .first();

        let sessionId: string;
        let fromStatus: string | null = null;

        if (existingSession) {
          sessionId = existingSession.id as string;
          fromStatus = 'queued';
          // セッションを「プロビジョニング中」に更新
          await env.DB.prepare(
            'UPDATE server_sessions SET status = ? WHERE id = ?'
          )
          .bind('provisioning', sessionId)
          .run();
        } else {
          // フォールバック: 存在しなければ新規作成
          sessionId = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO server_sessions (id, user_id, preset_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(sessionId, userId, presetId, 'provisioning', new Date().toISOString())
          .run();
        }

        // 状態遷移ログの記録
        await env.DB.prepare(
          'INSERT INTO server_status_logs (session_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
        )
        .bind(sessionId, fromStatus, 'provisioning', 'Provisioner process started')
        .run();

        // 2. CloudManager (Oracle -> AWS) によるプロビジョニング実行
        console.log(`[Provisioner] Triggering CloudManager with fallback logic...`);
        const instance = await cloudManager.provisionWithFallback({ presetId });

        // 3. 成功した場合、セッション情報を更新 (プロバイダー、インスタンスID、トンネルIPアドレスを保存)
        await env.DB.prepare(
          'UPDATE server_sessions SET status = ?, cloud_provider = ?, instance_id = ?, ip_address = ? WHERE id = ?'
        )
        .bind('running', instance.provider, instance.id, instance.ipAddress || '', sessionId)
        .run();

        // 状態遷移ログの記録
        await env.DB.prepare(
          'INSERT INTO server_status_logs (session_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)'
        )
        .bind(sessionId, 'provisioning', 'running', 'provisioned')
        .run();

        console.log(`[Provisioner] Successfully updated session ${sessionId} as running on ${instance.provider}`);
        msg.ack(); // キューからメッセージを正常に削除
      } catch (error: any) {
        console.error(`[Provisioner] Error processing message: ${error.message}`);
        // 失敗した場合の再試行制御 (Cloudflare Queues の標準機能に依存)
        msg.retry(); 
      }
    }
  },
};
