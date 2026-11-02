import { ICloudProvider, ServerInstance, InstanceStatus, ProvisionOptions, CloudProviderType } from './types';

export class AWSProvider implements ICloudProvider {
  public readonly type: CloudProviderType = 'aws';

  async provision(options: ProvisionOptions): Promise<ServerInstance> {
    console.log(`[AWS] Provisioning EC2 (t3/t4g) instance for preset ${options.presetId}...`);
    
    // AWSはキャパシティ問題が起きにくいため、基本的に成功するモックとする
    // ※実運用時はAWS SDK (aws-sdk-v3) を使用してRunInstancesを実行する
    return {
      id: `i-mock${Date.now().toString().slice(-8)}`,
      provider: 'aws',
      status: 'provisioning',
      createdAt: new Date(),
    };
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    return 'running';
  }

  async terminate(instanceId: string): Promise<void> {
    console.log(`[AWS] Terminating instance ${instanceId}...`);
  }
}
