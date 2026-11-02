export type InstanceStatus = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';
export type CloudProviderType = 'oracle' | 'aws' | 'local';

export interface ServerInstance {
  id: string; // OCID or AWS Instance ID or Docker container ID
  provider: CloudProviderType;
  status: InstanceStatus;
  ipAddress?: string;
  createdAt: Date;
}

export interface ProvisionOptions {
  presetId: string;
  profile?: 'standard' | 'performance'; // standard(Oracle/local), performance(AWS)
}

/**
 * すべてのクラウドプロバイダーが実装すべき共通のインターフェース
 */
export interface ICloudProvider {
  /** プロバイダー識別子 */
  readonly type: CloudProviderType;
  
  /**
   * 仮想マシンを新規にプロビジョニングする
   */
  provision(options: ProvisionOptions): Promise<ServerInstance>;
  
  /**
   * 仮想マシンの状態を取得する
   */
  getStatus(instanceId: string): Promise<InstanceStatus>;
  
  /**
   * 仮想マシンを完全に破棄する
   */
  terminate(instanceId: string): Promise<void>;
}
