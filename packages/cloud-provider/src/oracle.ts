import { ICloudProvider, ServerInstance, InstanceStatus, ProvisionOptions, CloudProviderType } from './types';

export class OracleCloudProvider implements ICloudProvider {
  public readonly type: CloudProviderType = 'oracle';

  async provision(options: ProvisionOptions): Promise<ServerInstance> {
    console.log(`[Oracle] Provisioning ARM Ampere instance for preset ${options.presetId}...`);
    
    // OCI Out of Capacity (OOC) をシミュレートするため、一定確率でエラーを投げる
    // ※実運用時はOCI SDKを使用してリソース作成リクエストを行う
    const oocProbability = 0.3; // 30%の確率で失敗
    if (Math.random() < oocProbability) {
      throw new Error('OCI_OUT_OF_CAPACITY: Oracle Cloud ARM Ampere resources are currently unavailable in this region.');
    }

    return {
      id: `ocid1.instance.oc1.ap-tokyo-1.mock-${Date.now()}`,
      provider: 'oracle',
      status: 'provisioning',
      createdAt: new Date(),
    };
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    // モック: 常に running を返す
    return 'running';
  }

  async terminate(instanceId: string): Promise<void> {
    console.log(`[Oracle] Terminating instance ${instanceId}...`);
  }
}
