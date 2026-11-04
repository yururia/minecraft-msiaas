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
  async queue(batch: MessageBatch<ProvisionMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { presetId, userId } = msg.body;
      console.log(`[Provisioner] Received request to provision preset ${presetId} for user ${userId}`);

      let sessionId: string | null = null;
      let fromStatus: string | null = null;

      try {
        const existingSession = await env.DB.prepare(
          'SELECT id FROM server_sessions WHERE user_id = ? AND preset_id = ? AND status = ? AND stopped_at IS NULL'
        )
          .bind(userId, presetId, 'queued')
          .first();

        const nowIso = new Date().toISOString();

        if (existingSession) {
          sessionId = existingSession.id as string;
          fromStatus = 'queued';
          await env.DB.prepare('UPDATE server_sessions SET status = ? WHERE id = ?')
            .bind('provisioning', sessionId)
            .run();
        } else {
          sessionId = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO server_sessions (id, user_id, preset_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(sessionId, userId, presetId, 'provisioning', nowIso)
            .run();
        }

        await env.DB.prepare(
          'INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(sessionId, fromStatus, 'provisioning', 'Provisioner process started', 'Provisioner process started', nowIso)
          .run();

        console.log(`[Provisioner] Triggering CloudManager with fallback logic...`);
        const instance = await cloudManager.provisionWithFallback({ presetId });

        const doneIso = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE server_sessions SET status = ?, cloud_provider = ?, instance_id = ?, ip_address = ? WHERE id = ?'
        )
          .bind('running', instance.provider, instance.id, instance.ipAddress || '', sessionId)
          .run();

        await env.DB.prepare(
          'INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(sessionId, 'provisioning', 'running', 'provisioned', 'provisioned', doneIso)
          .run();

        console.log(`[Provisioner] Successfully updated session ${sessionId} as running on ${instance.provider}`);
        msg.ack();
      } catch (error: any) {
        console.error(`[Provisioner] Error processing message: ${error.message}`);
        if (sessionId) {
          const errIso = new Date().toISOString();
          await env.DB.prepare(
            'UPDATE server_sessions SET status = ?, stopped_at = ?, error_message = ? WHERE id = ?'
          )
            .bind('failed', errIso, error.message, sessionId)
            .run();
          await env.DB.prepare(
            'INSERT INTO server_status_logs (session_id, from_status, to_status, reason, detail, transitioned_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
            .bind(sessionId, 'provisioning', 'failed', `Provisioning error: ${error.message}`, error.message, errIso)
            .run();
        }
        msg.retry();
      }
    }
  },
};
