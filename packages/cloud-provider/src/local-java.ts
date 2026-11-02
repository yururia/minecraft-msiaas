import { ICloudProvider, ProvisionOptions, ServerInstance, InstanceStatus, CloudProviderType } from './types';

/**
 * Tauri環境で動作するJava直起動サーバー用のプロバイダー（Next.js側での型互換スタブ）
 * 実際のプロセス起動・制御はTauri Rust側が担当するため、このプロバイダーはブラウザ等のTauri外から呼ばれた際に
 * エラーをスローする役割を果たします。
 */
export class LocalJavaProvider implements ICloudProvider {
  get type(): CloudProviderType {
    return 'local';
  }

  async provision(options: ProvisionOptions): Promise<ServerInstance> {
    console.log(`[LocalJava] Provisioning local Java server instance for preset ${options.presetId}...`);
    return {
      id: `local-java-${Date.now()}`,
      provider: 'local',
      status: 'running',
      ipAddress: '127.0.0.1:25565',
      createdAt: new Date(),
    };
  }

  async getStatus(_instanceId: string): Promise<InstanceStatus> {
    return 'running';
  }

  async terminate(_instanceId: string): Promise<void> {
    // 停止はTauri Rust側のstop_serverコマンドが直接担当します
  }
}
