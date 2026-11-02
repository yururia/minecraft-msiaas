import { ProvisionOptions, ServerInstance } from './types';
import { OracleCloudProvider } from './oracle';
import { AWSProvider } from './aws';
import { LocalJavaProvider } from './local-java';

export * from './types';
export * from './oracle';
export * from './aws';
export * from './local-java';

/**
 * 複数のクラウドプロバイダーを管理し、フォールバックおよびローカル開発用プロビジョニングを提供するマネージャー
 */
export class CloudManager {
  private oracle: OracleCloudProvider;
  private aws: AWSProvider;
  private localJava: LocalJavaProvider;

  constructor() {
    this.oracle = new OracleCloudProvider();
    this.aws = new AWSProvider();
    this.localJava = new LocalJavaProvider();
  }

  /**
   * サーバーを起動します。
   * ローカル開発環境（dev）の場合はローカルJava直起動のスタブを呼び出し、
   * 本番環境ではOracle Cloud（失敗時はAWS EC2フォールバック）を使用します。
   */
  async provisionWithFallback(options: ProvisionOptions): Promise<ServerInstance> {
    // ローカル開発環境の場合はローカルJavaプロバイダーを実行（Tauri環境が必要なためエラーをスロー）
    if (process.env.ENVIRONMENT === 'dev') {
      console.log('[CloudManager] ローカル開発環境(dev)を検出しました。ローカルJavaプロバイダーを呼び出します。');
      return await this.localJava.provision(options);
    }

    try {
      console.log('--- Provisioning Process Started ---');
      // 優先プロバイダー (Oracle) で起動試行
      const instance = await this.oracle.provision(options);
      console.log(`[CloudManager] Success: Provisioned on Oracle Cloud (${instance.id})`);
      return instance;
    } catch (error: any) {
      console.error(`[CloudManager] Oracle provisioning failed: ${error.message}`);
      
      // OCIのリソース枯渇エラーの場合、AWSへフォールバック
      if (error.message.includes('OCI_OUT_OF_CAPACITY')) {
        console.log(`[CloudManager] Initiating fallback to AWS...`);
        try {
          const awsInstance = await this.aws.provision(options);
          console.log(`[CloudManager] Success: Fallback to AWS completed (${awsInstance.id})`);
          return awsInstance;
        } catch (awsError: any) {
          console.error(`[CloudManager] AWS fallback also failed: ${awsError.message}`);
          throw new Error('CRITICAL: All cloud providers failed to provision the instance.');
        }
      }

      // その他の予期せぬエラーはそのままスロー
      throw error;
    }
  }

  /**
   * インスタンスを破棄します。
   */
  async terminate(instanceId: string): Promise<void> {
    // ローカル開発環境の場合はローカルJavaプロバイダーのスタブを実行
    if (process.env.ENVIRONMENT === 'dev') {
      await this.localJava.terminate(instanceId);
      return;
    }

    // プレフィックスなどでどちらのクラウドか判別する想定（モック実装）
    if (instanceId.startsWith('ocid1')) {
      await this.oracle.terminate(instanceId);
    } else {
      await this.aws.terminate(instanceId);
    }
  }
}

