'use client';

import React, { useEffect, useState, useRef, Suspense } from 'react';
import { GlassCard } from '../../../components/GlassCard';
import { Button } from '../../../components/Button';
import { apiFetch } from '../../../lib/api';
import { playLevelUpSound } from '../../../lib/sound';
import { useSearchParams, useRouter } from 'next/navigation';

import { ServerSessionResponse } from '@msiaas/shared';

interface TauriWindow {
  __TAURI__?: {
    invoke: <T = unknown>(cmd: string, args?: Record<string, any>) => Promise<T>;
    event: {
      listen: <T = any>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
    };
  };
}

interface JavaInfo {
  available: boolean;
  version: string | null;
  path: string | null;
}

interface ServerStartResult {
  session_id: string;
  tunnel_address: string;
  pid: number;
  zip_path: string | null;
}

interface StatusLog {
  id: string;
  session_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  transitioned_at: string;
}

interface Preset {
  id: string;
  name: string;
  mc_version: string;
  loader: string;
}

type ModSideToggleChoice = 'client' | 'server' | 'both';

/** コンソールに保持するログ行の上限（数千行のDOMで処理落ちしないように切り詰める） */
const MAX_CONSOLE_LOGS = 400;
/** MOD一覧を一度に描画する件数（200件超を一括描画すると固まるため分割して表示する） */
const MOD_LIST_PAGE_SIZE = 40;

/**
 * 長いMOD一覧を分割描画するコンポーネント。
 * 最初は MOD_LIST_PAGE_SIZE 件だけ描画し、「さらに表示」で追加読み込みする。
 */
function ChunkedList<T>({
  items,
  renderItem,
  resetKey,
}: {
  items: T[];
  renderItem: (item: T, idx: number) => React.ReactNode;
  resetKey?: string;
}) {
  const [visible, setVisible] = useState(MOD_LIST_PAGE_SIZE);
  useEffect(() => {
    setVisible(MOD_LIST_PAGE_SIZE);
  }, [resetKey]);
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;
  return (
    <>
      {shown.map((item, idx) => renderItem(item, idx))}
      {remaining > 0 && (
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', justifyContent: 'center', padding: '0.4rem 0' }}>
          <button
            type="button"
            onClick={() => setVisible(v => v + MOD_LIST_PAGE_SIZE)}
            style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', borderRadius: '4px', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(0,0,0,0.35)', color: '#e5e7eb' }}
          >
            さらに {Math.min(MOD_LIST_PAGE_SIZE, remaining)} 件表示（残り {remaining} 件）
          </button>
          <button
            type="button"
            onClick={() => setVisible(items.length)}
            style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', borderRadius: '4px', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#9ca3af' }}
          >
            すべて表示
          </button>
        </div>
      )}
    </>
  );
}

interface PreLaunchModModalState {
  presetId: string;
  presetName: string;
  mcVersion: string;
  loader: string;
  allMods: any[];
  serverMods: any[];
  clientOnlyMods: any[];
  unknownMods: any[];
}

interface ClientRequiredModStatus {
  name: string;
  provider_id: string;
  side: string;
  has_download_url: boolean;
  installed_in_local_client: boolean;
  installed_in_server_dir: boolean;
  can_auto_supply: boolean;
}

interface MissingPrerequisiteMod {
  mod_id: string;
  required_by: string;
  scope: string;
  available_locally?: boolean;
  local_jar_name?: string | null;
}

interface SandboxCompatibilityReport {
  server_ready: boolean;
  client_join_ready: boolean;
  local_mods_dir: string;
  local_installed_count: number;
  required_client_mods: ClientRequiredModStatus[];
  missing_prerequisites: MissingPrerequisiteMod[];
  unresolved_mods: string[];
  summary_message: string;
  zip_insufficient?: boolean;
  confirmation_prompt?: string | null;
}

interface ClientHandshakeTestResult {
  reachable: boolean;
  latency_ms: number;
  version_name: string;
  protocol: number;
  online_players: number;
  max_players: number;
  message: string;
}

function ServersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const launchPresetId = searchParams.get('launchPresetId');

  const [activeSession, setActiveSession] = useState<ServerSessionResponse | null>(null);
  const [logs, setLogs] = useState<StatusLog[]>([]);
  const [modScanProgress, setModScanProgress] = useState<string | null>(null);
  const [sandboxScanning, setSandboxScanning] = useState<boolean>(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [launchingPresetId, setLaunchingPresetId] = useState<string>('');
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [launchProgress, setLaunchProgress] = useState<number>(0);
  const [settings, setSettings] = useState<any>(null);
  const [systemMemoryGb, setSystemMemoryGb] = useState<number>(16);
  const [zombieProcess, setZombieProcess] = useState<{ port_in_use: boolean, pid: number | null } | null>(null);
  const [globalIp, setGlobalIp] = useState<string>('');
  const [cmdInput, setCmdInput] = useState<string>('');
  const [preLaunchModal, setPreLaunchModal] = useState<PreLaunchModModalState | null>(null);
  const [unknownModChoices, setUnknownModChoices] = useState<Record<string, ModSideToggleChoice>>({});
  const [sandboxReport, setSandboxReport] = useState<SandboxCompatibilityReport | null>(null);
  const [resolvingMissing, setResolvingMissing] = useState<boolean>(false);
  const [resolveProgressText, setResolveProgressText] = useState<string>('');
  const [failedSearchMods, setFailedSearchMods] = useState<string[]>([]);
  const [inAppSearchMod, setInAppSearchMod] = useState<string | null>(null);
  const [inAppSearchQuery, setInAppSearchQuery] = useState<string>('');
  const [inAppSearchResults, setInAppSearchResults] = useState<any[]>([]);
  const [inAppSearching, setInAppSearching] = useState<boolean>(false);
  const [inAppAdding, setInAppAdding] = useState<boolean>(false);
  const [isDraggingJar, setIsDraggingJar] = useState<boolean>(false);
  const [syncingLocalMods, setSyncingLocalMods] = useState<boolean>(false);
  const [handshakeResult, setHandshakeResult] = useState<ClientHandshakeTestResult | null>(null);
  const [testingHandshake, setTestingHandshake] = useState<boolean>(false);
  const [resolvedBanner, setResolvedBanner] = useState<{ count: number; names: string[] } | null>(null);
  
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const prevStatusRef = useRef<string | null>(null);

  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  // サーバー起動完了時のレベルアップ効果音再生 & グローバルIPの取得
  useEffect(() => {
    if (activeSession) {
      const prevStatus = prevStatusRef.current;
      const currentStatus = activeSession.status;

      if (
        (prevStatus === 'queued' || prevStatus === 'provisioning' || prevStatus === 'fallback') &&
        currentStatus === 'running'
      ) {
        console.log('[Sound] Server is ONLINE! Playing level-up sound.');
        playLevelUpSound();
        
        // グローバルIPの非同期取得を開始
        const fetchGlobalIp = async () => {
          try {
            const res = await fetch('https://api.ipify.org?format=json');
            const data = await res.json();
            setGlobalIp(data.ip);
          } catch (err) {
            console.warn('Failed to fetch global IP:', err);
          }
        };
        fetchGlobalIp();
      }
      
      // 稼働中かつ globalIp がまだ未設定の場合、設定する
      if (currentStatus === 'running' && !globalIp) {
        const fetchGlobalIp = async () => {
          try {
            const res = await fetch('https://api.ipify.org?format=json');
            const data = await res.json();
            setGlobalIp(data.ip);
          } catch (err) {
            console.warn('Failed to fetch global IP:', err);
          }
        };
        fetchGlobalIp();
      }

      if (currentStatus === 'running' && !handshakeResult) {
        handleTestClientHandshake();
      }

      prevStatusRef.current = currentStatus;
    } else {
      prevStatusRef.current = null;
      setGlobalIp(''); // サーバー停止時はグローバルIPをクリア
      setHandshakeResult(null);
    }
  }, [activeSession, globalIp]);

  const fetchActiveServer = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await apiFetch('/api/servers/active');
      setActiveSession(data.session);
      // 3秒ごとのポーリングでRust側のリアルタイムログ（rust-log-*）やクライアント側ログが消えないよう、
      // APIのログと結合して時系列に並べ、上限件数で切り詰める
      const apiLogs: StatusLog[] = data.logs || [];
      setLogs(prev => {
        const localLogs = prev.filter(l => String(l.id).startsWith('rust-log-') || String(l.id).startsWith('client-log-'));
        if (localLogs.length === 0) return apiLogs.slice(-MAX_CONSOLE_LOGS);
        const merged = [...apiLogs, ...localLogs].sort(
          (a, b) => new Date(a.transitioned_at).getTime() - new Date(b.transitioned_at).getTime()
        );
        return merged.slice(-MAX_CONSOLE_LOGS);
      });
    } catch (err) {
      console.error('Failed to fetch active server:', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const fetchPresets = async () => {
    try {
      const data = await apiFetch('/api/presets');
      setPresets(data.presets || []);
      if (data.presets && data.presets.length > 0) {
        setLaunchingPresetId(data.presets[0].id);
      }
    } catch (err) {
      console.error('Failed to fetch presets:', err);
    }
  };

  // Tauri server-log イベントリスナー: Rust バックエンドからのリアルタイムログを受信
  // 200MOD規模のForgeでは数千行のログが流れるため、まとめて受信し、表示件数も上限で切り詰める
  useEffect(() => {
    if (!isTauri) return;
    const unlisteners: Array<() => void> = [];
    const toVirtualLog = (message: string): StatusLog => ({
      id: `rust-log-${Date.now()}-${Math.random()}`,
      session_id: 'rust',
      from_status: null,
      to_status: 'provisioning',
      reason: message,
      transitioned_at: new Date().toISOString()
    });
    const setupListener = async () => {
      try {
        const tauri = (window as unknown as TauriWindow).__TAURI__;
        if (tauri && tauri.event && tauri.event.listen) {
          unlisteners.push(await tauri.event.listen<string>('server-log', (event) => {
            setLogs(prev => [...prev, toVirtualLog(event.payload)].slice(-MAX_CONSOLE_LOGS));
          }));
          unlisteners.push(await tauri.event.listen<string[]>('server-log-batch', (event) => {
            const lines = event.payload || [];
            if (lines.length === 0) return;
            setLogs(prev => [...prev, ...lines.map(toVirtualLog)].slice(-MAX_CONSOLE_LOGS));
          }));
          unlisteners.push(await tauri.event.listen<string>('mod-scan-progress', (event) => {
            setModScanProgress(event.payload);
          }));
        }
      } catch (err) {
        console.warn('Failed to listen for server-log events:', err);
      }
    };
    setupListener();
    return () => { unlisteners.forEach(u => u()); };
  }, [isTauri]);

  const fetchSettings = async () => {
    try {
      const res = await apiFetch('/api/settings');
      if (res.settings) {
        setSettings(res.settings);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  // 定期ポーリング (3秒ごと) と初期起動チェック
  useEffect(() => {
    fetchActiveServer(true);
    fetchPresets();
    fetchSettings();

    const fetchSystemMemory = async () => {
      if (isTauri) {
        try {
          const tauri = (window as unknown as TauriWindow).__TAURI__;
          if (tauri) {
            const mem = await tauri.invoke<number>('get_system_memory');
            setSystemMemoryGb(mem);
          }
        } catch (err) {
          console.error('Failed to fetch system memory:', err);
        }
      }
    };

    const detectZombie = async () => {
      if (isTauri) {
        try {
          const tauri = (window as unknown as TauriWindow).__TAURI__;
          if (tauri) {
            const info = await tauri.invoke<{ port_in_use: boolean, pid: number | null }>('check_zombie_processes');
            if (info.port_in_use) {
              setZombieProcess(info);
            }
          }
        } catch (err) {
          console.error('Failed to check zombie processes:', err);
        }
      }
    };

    fetchSystemMemory();
    detectZombie();

    const interval = setInterval(() => {
      fetchActiveServer(false);
    }, 3000);

    return () => clearInterval(interval);
  }, [isTauri]);

  // クエリパラメータによる自動起動のハンドリング（多重実行・無限再レンダリング防止ガード）
  const handledLaunchPresetIdRef = useRef<string | null>(null);
  const isLaunchingModalRef = useRef(false);
  const isDiagnosingRef = useRef(false);

  useEffect(() => {
    if (
      launchPresetId &&
      handledLaunchPresetIdRef.current !== launchPresetId &&
      presets.length > 0 &&
      !loading &&
      !activeSession &&
      !launching
    ) {
      handledLaunchPresetIdRef.current = launchPresetId;
      console.log(`[AutoLaunch] Detected launchPresetId: ${launchPresetId}. Opening pre-launch MOD confirmation...`);
      router.replace('/dashboard/servers');
      handleLaunch(launchPresetId);
    }
  }, [launchPresetId, presets, loading, activeSession, launching, router]);

  const parseErrorMessage = (msg: string) => {
    if (msg.includes('JAVA_NOT_FOUND')) {
      return 'システムにJavaが見つかりません。Adoptium OpenJDKなどからJava 21以上をインストールし、アプリを再起動してください。';
    }
    if (msg.includes('TAURI_REQUIRED')) {
      return '専用デスクトップアプリ(Tauri)が必要です。WebブラウザからローカルJavaサーバーは起動できません。';
    }
    if (msg.includes('Failed to fetch version manifest') || msg.includes('download server.jar') || msg.includes('Downloads')) {
      return 'Mojang APIからのサーバーJARのダウンロードに失敗しました。ネットワーク接続状態を確認してください。';
    }
    if (msg.includes('Failed to spawn Java process') || msg.includes('java.exe')) {
      return 'Javaプロセスの起動に失敗しました。Javaの実行可能パスが正しいか、またはシステムメモリが十分にあるか確認してください。';
    }
    if (msg.includes('boot timed out')) {
      return 'サーバーの起動待機中にタイムアウト（5分）しました。サーバーフォルダ内のログ等を確認してください。';
    }
    if (msg.includes('exited prematurely')) {
      return 'Javaサーバープロセスが起動直後に異常終了しました。既に同じポートで他のサーバーが起動していないか、またはJavaのバージョン不適合、メモリ不足などが考えられます。';
    }
    if (msg.includes('Failed to spawn SSH') || msg.includes('SSH process')) {
      return '外部接続用SSHトンネル（serveo.net）の起動に失敗しました。ホストPCのネットワーク接続状況を確認してください。';
    }
    return msg;
  };

  // サンドボックス互換診断（サーバー起動準備 & クライアント入室テスト & .minecraft/mods 検査）
  const runSandboxDiagnosis = async (mcVersion: string, loader: string, allMods: any[], presetIdOverride?: string) => {
    if (isDiagnosingRef.current) return;
    isDiagnosingRef.current = true;
    try {
      const mappedMods = allMods.map(m => ({
        id: m.id,
        name: m.name,
        provider_id: m.provider_id || m.external_id || '',
        download_url: m.download_url || '',
        is_server_side: m.is_server_side ?? 1,
        is_client_side: m.is_client_side ?? 1,
      }));

      if (isTauri) {
        try {
          const tauri = (window as unknown as TauriWindow).__TAURI__;
          if (tauri) {
            setSandboxScanning(true);
            setModScanProgress(`🔍 MOD構成を解析しています... (${mappedMods.length}件)`);
            // 解析中もUIが描画・操作できるよう、Rust側はバックグラウンドスレッドで処理する
            const report = await tauri.invoke<SandboxCompatibilityReport>('verify_client_and_server_sandbox', {
              presetId: presetIdOverride || preLaunchModal?.presetId || launchingPresetId,
              mcVersion,
              loader,
              presetMods: mappedMods,
            });
            setSandboxReport(report);
            return;
          }
        } catch (err) {
          console.warn('Tauri verify_client_and_server_sandbox failed, falling back to browser check:', err);
        } finally {
          setSandboxScanning(false);
        }
      }

      // ブラウザモード用フォールバック診断
      const requiredClientMods: ClientRequiredModStatus[] = mappedMods
        .filter(m => m.is_client_side !== 0)
        .map(m => ({
          name: m.name,
          provider_id: m.provider_id,
          side: m.is_server_side !== 0 && m.is_client_side !== 0 ? 'both' : 'client',
          has_download_url: Boolean(m.download_url && m.download_url.trim() !== ''),
          installed_in_local_client: false,
          installed_in_server_dir: false,
          can_auto_supply: Boolean(m.download_url && m.download_url.trim() !== ''),
        }));

      const unresolvedMods = mappedMods
        .filter(m => !m.download_url || m.download_url.trim() === '')
        .map(m => m.name);

      const hasFabricApi = mappedMods.some(
        m =>
          String(m.provider_id).toLowerCase().includes('fabric-api') ||
          String(m.name).toLowerCase().includes('fabric api')
      );
      const missingPrerequisites: MissingPrerequisiteMod[] =
        loader.toLowerCase() === 'fabric' && mappedMods.length > 0 && !hasFabricApi
          ? [{ mod_id: 'fabric-api', required_by: 'Fabric MOD群 (共通前提API)', scope: 'both' }]
          : [];

      setSandboxReport({
        server_ready: unresolvedMods.length === 0 && missingPrerequisites.length === 0,
        client_join_ready: false,
        local_mods_dir: '%APPDATA%\\.minecraft\\mods',
        local_installed_count: 0,
        required_client_mods: requiredClientMods,
        missing_prerequisites: missingPrerequisites,
        unresolved_mods: unresolvedMods,
        summary_message:
          unresolvedMods.length > 0 || missingPrerequisites.length > 0
            ? `⚠️ 不足している前提MOD（${missingPrerequisites.length}件）またはDLリンク未解決MOD（${unresolvedMods.length}件）が検出されました。「不足MODを自動検索・補完」を実行してください。`
            : '✅ サーバー・クライアント用MODのDLリンクはすべて解決済みです（デスクトップアプリ版では .minecraft/mods との自動同期も実行できます）。',
      });
    } finally {
      isDiagnosingRef.current = false;
    }
  };

  // 不足前提MOD・未解決URLのワンクリック自動補完
  const handleResolveMissingInModal = async () => {
    if (!preLaunchModal) return;
    try {
      setResolvingMissing(true);
      setResolveProgressText('🌐 Modrinth / CurseForge から不足前提MODを検索しています...');
      const missingIds = (sandboxReport?.missing_prerequisites || []).map(mp => mp.mod_id);
      
      const res = await apiFetch(`/api/presets/${preLaunchModal.presetId}/resolve-missing`, {
        method: 'POST',
        body: JSON.stringify({ missingModIds: missingIds }),
      });

      setResolveProgressText('💾 プリセット構成を更新しています...');
      const updatedMods: any[] = res.mods || [];
      const serverMods: any[] = [];
      const clientOnlyMods: any[] = [];
      const unknownMods: any[] = [];
      for (const m of updatedMods) {
        const isUnknownJar = m.license === 'Custom JAR' && m.is_server_side === 0 && String(m.external_id || '').includes('unknown');
        if (isUnknownJar) {
          unknownMods.push(m);
        } else if (m.is_server_side === 0) {
          clientOnlyMods.push(m);
        } else {
          serverMods.push(m);
        }
      }

      setPreLaunchModal({
        ...preLaunchModal,
        allMods: updatedMods,
        serverMods,
        clientOnlyMods,
        unknownMods,
      });

      setResolveProgressText('🧪 互換性を再検証しています...');
      await runSandboxDiagnosis(preLaunchModal.mcVersion, preLaunchModal.loader, updatedMods);
      
      // 自動取得できなかったMODを記録（アプリ内手動検索・D&D連携用）
      const resolvedIdSet = new Set(
        (res.resolvedMods || []).flatMap((r: any) => [
          String(r.modId || '').toLowerCase(),
          String(r.name || '').toLowerCase(),
        ])
      );
      const stillMissing = missingIds.filter(
        id => !resolvedIdSet.has(id.toLowerCase())
      );
      const combinedFailed = Array.from(
        new Set([...(res.failedSearchModIds || []), ...stillMissing])
      );
      setFailedSearchMods(combinedFailed);

      const count = res.resolvedMods?.length || 0;
      if (count > 0) {
        const resolvedNames = res.resolvedMods.map((r: any) => r.name);
        setResolvedBanner({
          count,
          names: resolvedNames,
        });
      }

      if (combinedFailed.length > 0) {
        alert(
          `⚠️ 一部のMOD（${combinedFailed.join(', ')}）は外部配布サイトで見つかりませんでした。\n` +
          `下の「🔍 アプリ内で手動検索して追加」または「JARドラッグ＆ドロップ枠」から手動で追加してください。`
        );
      } else if (count === 0) {
        alert('自動補完できる追加のMODはありませんでした。手動で追加したい場合は「🔎 アプリ内でMODを手動検索して追加」ボタンから検索できます。');
      }
    } catch (err: any) {
      alert(`自動補完に失敗しました: ${err.message}`);
    } finally {
      setResolvingMissing(false);
      setResolveProgressText('');
    }
  };

  const formatModQueryForSearch = (raw: string): string => {
    let q = raw.trim().replace(/\.(jar|zip)$/i, '').replace(/[-_]v?\d+(\.\d+)+.*$/i, '');
    const key = q.toLowerCase().replace(/[^a-z0-9]/g, '');
    const MOD_ALIAS_FRONTEND: Record<string, string> = {
      'epicfightavalon': 'Epic Fight Avalon',
      'dodgeparryreward': 'Epic Fight : Dodge Parry Reward',
      'p1neroec': "P1nero's Epic X Cataclysm",
      'swordsoaring': 'Epic Fight - Sword Soaring',
      'p1nerobow': "P1nero's Epic Bow",
      'p1nerodl': "P1nero's Dialogue Lib",
      'epicfight': 'Epic Fight',
      'efn': 'EpicFight-Nightfall',
      'babt': 'Brass Amber Battle Towers',
      'attributeslib': 'Apothic Attributes',
    };
    if (MOD_ALIAS_FRONTEND[key]) {
      return MOD_ALIAS_FRONTEND[key];
    }
    return q.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  };

  // アプリ内手動検索モーダルを開く
  const handleOpenInAppSearch = (modName: string) => {
    const formatted = formatModQueryForSearch(modName);
    setInAppSearchMod(modName);
    setInAppSearchQuery(formatted);
    setInAppSearchResults([]);
    handleExecuteInAppSearch(formatted);
  };

  // ユーザーが「内包ライブラリまたは不要MOD」として不足判定から手動選別・除外する処理
  const handleIgnoreMissingMod = (modIdToIgnore: string) => {
    // 1. 自動取得失敗リストから削除
    setFailedSearchMods(prev => prev.filter(m => m.toLowerCase() !== modIdToIgnore.toLowerCase()));

    // 2. sandboxReport から除外
    if (sandboxReport) {
      const remainingMissing = sandboxReport.missing_prerequisites.filter(
        mp => mp.mod_id.toLowerCase() !== modIdToIgnore.toLowerCase()
      );
      const remainingUnresolved = sandboxReport.unresolved_mods.filter(
        u => u.toLowerCase() !== modIdToIgnore.toLowerCase()
      );
      const isServerReady =
        remainingUnresolved.length === 0 &&
        !remainingMissing.some(mp => mp.scope === 'server' || mp.scope === 'both');

      setSandboxReport({
        ...sandboxReport,
        missing_prerequisites: remainingMissing,
        unresolved_mods: remainingUnresolved,
        server_ready: isServerReady,
        summary_message:
          remainingMissing.length === 0 && remainingUnresolved.length === 0
            ? '✅ すべての前提MOD・URLが解決（または除外承認）されました。この構成でサーバーを起動できます。'
            : sandboxReport.summary_message,
        confirmation_prompt:
          remainingMissing.length === 0 && remainingUnresolved.length === 0
            ? undefined
            : sandboxReport.confirmation_prompt,
      });
    }
  };

  const handleExecuteInAppSearch = async (queryToSearch: string) => {
    if (!preLaunchModal || !queryToSearch.trim()) return;
    const cleaned = queryToSearch.trim().replace(/\.(jar|zip)$/i, '');
    try {
      setInAppSearching(true);
      const res = await apiFetch(
        `/api/mods/search?q=${encodeURIComponent(cleaned)}&mc_version=${preLaunchModal.mcVersion}&loader=${preLaunchModal.loader}`
      );
      setInAppSearchResults(res.mods || []);
    } catch (err) {
      console.error(err);
      alert('MOD検索に失敗しました。');
    } finally {
      setInAppSearching(false);
    }
  };

  // 検索結果からプリセット構成に追加する
  const handleInAppAddMod = async (searchedMod: any) => {
    if (!preLaunchModal) return;
    try {
      setInAppAdding(true);
      // 1. マスタDBに登録
      const cacheRes = await apiFetch('/api/mods', {
        method: 'POST',
        body: JSON.stringify({
          source: searchedMod.source || 'modrinth',
          external_id: searchedMod.id,
          name: searchedMod.title,
          mc_version: preLaunchModal.mcVersion,
          loader: preLaunchModal.loader,
          license: searchedMod.license || 'Unknown',
          download_url: searchedMod.download_url || '',
          client_side: searchedMod.client_side || 'optional',
          server_side: searchedMod.server_side || 'optional',
        }),
      });
      const newModUuid = cacheRes.id;

      // 2. プリセットに追加
      const currentIds = preLaunchModal.allMods.map(m => m.id);
      if (!currentIds.includes(newModUuid)) {
        await apiFetch(`/api/presets/${preLaunchModal.presetId}/mods`, {
          method: 'PUT',
          body: JSON.stringify({ mod_ids: [...currentIds, newModUuid] }),
        });
      }

      // 3. プリセット情報再取得＆互換診断再実行
      const updatedPresetRes = await apiFetch(`/api/presets/${preLaunchModal.presetId}`);
      const updatedMods = updatedPresetRes.mods || [];
      const serverMods = updatedMods.filter((m: any) => m.is_server_side !== 0);
      const clientOnlyMods = updatedMods.filter((m: any) => m.is_server_side === 0);

      setPreLaunchModal({
        ...preLaunchModal,
        allMods: updatedMods,
        serverMods,
        clientOnlyMods,
      });

      // 失敗リストから該当を削除
      if (inAppSearchMod) {
        setFailedSearchMods(prev => prev.filter(m => m.toLowerCase() !== inAppSearchMod.toLowerCase()));
      }
      setInAppSearchMod(null);

      await runSandboxDiagnosis(preLaunchModal.mcVersion, preLaunchModal.loader, updatedMods);
      alert(`✅ MOD「${searchedMod.title}」を構成に追加しました！`);
    } catch (err: any) {
      alert(`MOD追加エラー: ${err.message}`);
    } finally {
      setInAppAdding(false);
    }
  };

  // 手動JARファイルのドラッグ＆ドロップ追加
  const handleDropCustomJar = async (file: File) => {
    if (!preLaunchModal) return;
    if (!file.name.toLowerCase().endsWith('.jar')) {
      alert('JARファイル（.jar）のみ追加可能です。');
      return;
    }
    try {
      setInAppAdding(true);
      const baseStem = file.name.replace(/\.jar$/i, '');
      const localExtId = `local:${baseStem.toLowerCase()}`;
      
      const cacheRes = await apiFetch('/api/mods', {
        method: 'POST',
        body: JSON.stringify({
          source: 'modrinth',
          external_id: localExtId,
          name: baseStem,
          mc_version: preLaunchModal.mcVersion,
          loader: preLaunchModal.loader,
          license: 'Custom JAR',
          download_url: '',
          client_side: 'optional',
          server_side: 'optional',
        }),
      });

      const currentIds = preLaunchModal.allMods.map(m => m.id);
      if (!currentIds.includes(cacheRes.id)) {
        await apiFetch(`/api/presets/${preLaunchModal.presetId}/mods`, {
          method: 'PUT',
          body: JSON.stringify({ mod_ids: [...currentIds, cacheRes.id] }),
        });
      }

      const updatedPresetRes = await apiFetch(`/api/presets/${preLaunchModal.presetId}`);
      const updatedMods = updatedPresetRes.mods || [];
      setPreLaunchModal({
        ...preLaunchModal,
        allMods: updatedMods,
        serverMods: updatedMods.filter((m: any) => m.is_server_side !== 0),
        clientOnlyMods: updatedMods.filter((m: any) => m.is_server_side === 0),
      });

      // 該当があれば失敗リストから削除
      setFailedSearchMods(prev => prev.filter(m => !baseStem.toLowerCase().includes(m.toLowerCase())));
      await runSandboxDiagnosis(preLaunchModal.mcVersion, preLaunchModal.loader, updatedMods);
      alert(`✅ ローカルJAR「${file.name}」をプリセット構成に追加しました！`);
    } catch (err: any) {
      alert(`JAR追加エラー: ${err.message}`);
    } finally {
      setInAppAdding(false);
    }
  };

  // このPCの .minecraft/mods へ必要クライアントMODを一括同期
  const handleSyncClientModsToLocal = async () => {
    if (!preLaunchModal) return;
    if (!isTauri) {
      alert('ローカルの .minecraft/mods フォルダへの直接同期は、デスクトップアプリ（Minecraft MSIaaS.exe）からご利用いただけます。');
      return;
    }
    try {
      setSyncingLocalMods(true);
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (!tauri) return;

      const mappedMods = preLaunchModal.allMods.map(m => ({
        id: m.id,
        name: m.name,
        provider_id: m.provider_id || m.external_id || '',
        download_url: m.download_url || '',
        is_server_side: m.is_server_side ?? 1,
        is_client_side: m.is_client_side ?? 1,
      }));

      const syncRes = await tauri.invoke<{
        synced_count: number;
        already_present_count: number;
        failed_mods: string[];
        target_dir: string;
      }>('sync_client_mods_to_local_minecraft', {
        presetId: preLaunchModal.presetId,
        mcVersion: preLaunchModal.mcVersion,
        loader: preLaunchModal.loader,
        clientMods: mappedMods,
      });

      await runSandboxDiagnosis(preLaunchModal.mcVersion, preLaunchModal.loader, preLaunchModal.allMods);
      alert(
        `✅ クライアント用MOD同期完了！\n` +
          `・新規コピー/DL: ${syncRes.synced_count}件\n` +
          `・導入済み: ${syncRes.already_present_count}件\n` +
          `・保存先: ${syncRes.target_dir}` +
          (syncRes.failed_mods.length > 0 ? `\n⚠️ 未解決: ${syncRes.failed_mods.join(', ')}` : '')
      );
    } catch (err: any) {
      alert(`ローカルMOD同期エラー: ${err}`);
    } finally {
      setSyncingLocalMods(false);
    }
  };

  // 稼働中サーバーへのクライアント入室Handshakeテスト
  const handleTestClientHandshake = async () => {
    if (!isTauri) return;
    try {
      setTestingHandshake(true);
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (tauri) {
        const res = await tauri.invoke<ClientHandshakeTestResult>('test_minecraft_client_handshake', {
          host: '127.0.0.1',
          port: 25565,
        });
        setHandshakeResult(res);
      }
    } catch (err) {
      console.warn('Handshake test failed:', err);
    } finally {
      setTestingHandshake(false);
    }
  };

  // Step 3: サーバー起動前に MOD Side 確認モーダルを表示
  const handleLaunch = async (targetPresetId?: string) => {
    const presetIdToLaunch = targetPresetId || launchingPresetId;
    if (!presetIdToLaunch || isLaunchingModalRef.current) return;
    isLaunchingModalRef.current = true;
    setLaunchError(null);
    setZipPath(null);

    const selectedPreset = presets.find(p => p.id === presetIdToLaunch);
    const presetName = selectedPreset ? selectedPreset.name : 'Unknown Preset';

    try {
      const detail = await apiFetch(`/api/presets/${presetIdToLaunch}`);
      const allMods: any[] = detail.mods || [];

      const serverMods: any[] = [];
      const clientOnlyMods: any[] = [];
      const unknownMods: any[] = [];
      const initialChoices: Record<string, ModSideToggleChoice> = {};

      for (const m of allMods) {
        const isUnknownJar = m.license === 'Custom JAR' && m.is_server_side === 0 && String(m.external_id || '').includes('unknown');
        if (isUnknownJar) {
          unknownMods.push(m);
          initialChoices[m.name] = 'client'; // デフォルトで除外
        } else if (m.is_server_side === 0) {
          clientOnlyMods.push(m);
        } else {
          serverMods.push(m);
        }
      }

      const mcVer = selectedPreset?.mc_version || detail.preset?.mc_version || '1.20.1';
      const modLoader = selectedPreset?.loader || detail.preset?.loader || 'fabric';

      setUnknownModChoices(initialChoices);
      setSandboxReport(null); // 前回プリセットの診断結果を残さない
      setPreLaunchModal({
        presetId: presetIdToLaunch,
        presetName,
        mcVersion: mcVer,
        loader: modLoader,
        allMods,
        serverMods,
        clientOnlyMods,
        unknownMods,
      });

      await runSandboxDiagnosis(mcVer, modLoader, allMods, presetIdToLaunch);
    } catch (err: any) {
      // 万一プリセット詳細取得に失敗した場合はそのまま確認実行へ進む
      await executeLaunch(presetIdToLaunch, undefined);
    } finally {
      isLaunchingModalRef.current = false;
    }
  };

  const handleConfirmPreLaunchModal = async () => {
    if (!preLaunchModal) return;
    let { presetId, serverMods, unknownMods } = preLaunchModal;

    // サーバー側またはクライアント側にZIP（現在の構成）だけでは足りないMODがある場合の判定＆注意文確認
    const hasMissingMods =
      sandboxReport &&
      (sandboxReport.missing_prerequisites.length > 0 || sandboxReport.unresolved_mods.length > 0);

    if (hasMissingMods && sandboxReport) {
      const defaultPrompt = [
        '⚠️ 【注意】ZIPファイル内のMOD構成だけでは、サーバー側またはクライアント側で必要な以下のMODが不足しています：',
        ...sandboxReport.missing_prerequisites.map(
          mp =>
            `  ・${mp.mod_id} （要求元: ${mp.required_by} ／ ${
              mp.scope === 'server'
                ? 'サーバー側で必須'
                : mp.scope === 'client'
                ? 'クライアント側で必須'
                : 'サーバー・クライアント双方で必須'
            }）`
        ),
        ...sandboxReport.unresolved_mods.map(u => `  ・${u} （本体JAR・DLリンク未解決）`),
        '',
        'このMODが足りないため、プリセット構成に入れてもかまいませんか？',
        '（「OK」を押すと不足MODを自動検索・構成に追加してからサーバーを起動します）',
      ].join('\n');

      const allowAdd = confirm(sandboxReport.confirmation_prompt || defaultPrompt);
      if (allowAdd) {
        try {
          setResolvingMissing(true);
          const missingIds = sandboxReport.missing_prerequisites.map(mp => mp.mod_id);
          const res = await apiFetch(`/api/presets/${presetId}/resolve-missing`, {
            method: 'POST',
            body: JSON.stringify({ missingModIds: missingIds }),
          });
          const updatedMods: any[] = res.mods || [];
          serverMods = updatedMods.filter(m => m.is_server_side !== 0);
          const count = res.resolvedMods?.length || 0;
          if (count > 0) {
            const resolvedNames = res.resolvedMods.map((r: any) => r.name);
            setResolvedBanner({
              count,
              names: resolvedNames,
            });
          }
        } catch (err) {
          console.warn('Auto resolve before launch failed:', err);
        } finally {
          setResolvingMissing(false);
        }
      }
    }

    const approvedServerModNames: string[] = [
      ...serverMods.map(m => m.name as string),
      ...unknownMods
        .filter(m => {
          const choice = unknownModChoices[m.name] || 'client';
          return choice === 'server' || choice === 'both';
        })
        .map(m => m.name as string),
    ];
    setPreLaunchModal(null);
    await executeLaunch(presetId, approvedServerModNames);
  };

  const executeLaunch = async (presetIdToLaunch: string, approvedServerModNames?: string[]) => {
    const selectedPreset = presets.find(p => p.id === presetIdToLaunch);
    const presetName = selectedPreset ? selectedPreset.name : 'Unknown Preset';

    // 1. EULA同意ダイアログの表示 (初回ダイアログ)
    const eulaAgreed = confirm(
      '【重要：Minecraft EULAへの同意】\n\n' +
      'サーバーを起動するには、MojangのMinecraftエンドユーザーライセンス利用規約（EULA）に同意する必要があります。\n' +
      '起動を進めることで、あなたはMinecraft EULA（https://www.minecraft.net/eula）に同意したとみなされます。\n\n' +
      '同意してサーバーを起動しますか？'
    );
    if (!eulaAgreed) return;

    let createdSession: any = null;
    let unlistenProgress: (() => void) | null = null;

    // クライアント側でリアルタイムに進捗を表示するためのヘルパー
    const addClientLog = (toStatus: string, reason: string) => {
      const virtualLog: StatusLog = {
        id: `client-log-${Date.now()}-${Math.random()}`,
        session_id: createdSession?.id || activeSession?.id || 'temp',
        from_status: null,
        to_status: toStatus,
        reason: reason,
        transitioned_at: new Date().toISOString()
      };
      setLogs(prev => [...prev, virtualLog].slice(-MAX_CONSOLE_LOGS));

      // ターミナル（Tauri標準出力）にも即座に出力
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (isTauri && tauri) {
        tauri.invoke('log_to_terminal', { message: reason }).catch((err) => {
          console.error('Failed to log to terminal:', err);
        });
      } else {
        console.log(`[UI Log] ${reason}`);
      }
    };

    try {
      setLaunching(true);
      setLaunchProgress(5);
      addClientLog('queued', '起動リクエストを受け付けました。EULAに同意済み。');

      if (isTauri) {
        const tauri = (window as unknown as TauriWindow).__TAURI__;
        if (tauri && tauri.event && tauri.event.listen) {
          unlistenProgress = await tauri.event.listen<number>('server-launch-progress', (event) => {
            const pct = event.payload;
            console.log(`[Tauri Progress] ${pct}%`);
            setLaunchProgress(pct);
          });
        }

        setLaunchProgress(10);
        addClientLog('provisioning', '【1/5】ローカルJava環境をチェックしています...');
        if (!tauri) throw new Error('TAURI_REQUIRED: tauri is undefined');

        // まず、Javaがインストールされているか確認
        const javaInfo = await tauri.invoke<JavaInfo>('check_java_available');
        if (!javaInfo.available && !settings?.javaPath) {
          throw new Error('JAVA_NOT_FOUND: システムにJavaが見つかりません。');
        }
        setLaunchProgress(20);
        addClientLog('provisioning', `✔️ Javaを検出しました: ${settings?.javaPath || `${javaInfo.version} (${javaInfo.path})`}`);

        setLaunchProgress(25);
        addClientLog('queued', '【2/5】データベースに起動セッションを作成しています...');
        // DBにセッションレコードを 'queued' で作成（ローカルJava起動なのでクラウド回数制限から除外）
        const launchRes = await apiFetch('/api/servers/launch', {
          method: 'POST',
          body: JSON.stringify({ presetId: presetIdToLaunch, cloudProvider: 'local' }),
        });
        createdSession = launchRes.session;
        setLaunchProgress(30);
        addClientLog('queued', `✔️ セッションの作成に成功しました。ID: ${createdSession.id}`);

        setLaunchProgress(35);
        addClientLog('provisioning', '【3/5】サーバーJARおよびサーバー対象MODのダウンロード・配置を開始します（クライアント専用MODは自動スキップ）...');
        // セッション状態を 'provisioning' に更新
        await apiFetch('/api/servers/session', {
          method: 'PUT',
          body: JSON.stringify({
            sessionId: createdSession.id,
            status: 'provisioning',
            cloudProvider: 'local',
            reason: 'ローカルJavaサーバーの起動を開始します（Java環境の確認、JAR・MODダウンロード中...）'
          }),
        });

        setLaunchProgress(40);
        addClientLog('provisioning', '【4/5】Tauri Rustバックエンドに起動命令を送信しました。サーバー起動を待機中（これには10秒〜60秒ほどかかります）...');
        // Rust側でJavaサーバー + トンネルを非同期起動
        const result = await tauri.invoke<ServerStartResult>('start_server', {
          sessionId: createdSession.id,
          presetId: presetIdToLaunch,
          presetName: presetName,
          mcVersion: createdSession.mcVersion,
          loader: createdSession.loader,
          allocatedMemoryGb: settings?.defaultMemoryGb ?? 4,
          approvedServerModNames: approvedServerModNames ?? null,
          customJavaPath: settings?.javaPath || null,
          usePlayitGg: settings?.usePlayitGg ?? true,
          properties: {
            pvp: settings?.pvp ?? true,
            difficulty: settings?.difficulty ?? 'easy',
            gamemode: settings?.gamemode ?? 'survival',
            maxPlayers: settings?.maxPlayers ?? 20,
            allowFlight: settings?.allowFlight ?? false,
            whiteList: settings?.whiteList ?? false,
            viewDistance: settings?.viewDistance ?? 6,
            motd: settings?.motd ?? 'MSIaaS Local Server',
          }
        });

        setLaunchProgress(75);
        addClientLog('running', `✔️ Javaプロセスの起動を確認しました！ (PID: ${result.pid})`);
        
        if (result.zip_path) {
          setLaunchProgress(80);
          addClientLog('running', `✔️ 共有用「らくらくZIPパック」の生成に成功しました。`);
          setZipPath(result.zip_path);
        }

        setLaunchProgress(85);
        const isPlayitUsed = result.tunnel_address.includes('joinmc.link') || result.tunnel_address.includes('ply.gg');
        if (isPlayitUsed) {
          addClientLog('running', `【5/5】playit.gg による超安定カスタムドメイン（${result.tunnel_address}）を開通しています...`);
        } else {
          addClientLog('running', `【5/5】serveo.net による外部接続トンネルを開通しています...`);
        }

        // 起動成功 → 状態を 'running' に更新
        await apiFetch('/api/servers/session', {
          method: 'PUT',
          body: JSON.stringify({
            sessionId: createdSession.id,
            status: 'running',
            ipAddress: result.tunnel_address,
            instanceId: String(result.pid),
            javaPid: result.pid,
            cloudProvider: 'local',
            reason: isPlayitUsed 
              ? `サーバーの起動に成功しました。超安定接続ドメイン（${result.tunnel_address}）が割り当てられました！`
              : 'サーバーの起動に成功しました。接続アドレスが割り当てられました。'
          }),
        });

        setLaunchProgress(100);
        addClientLog('running', isPlayitUsed
          ? `🚀 サーバーはオンラインです！ 接続用アドレス（友達招待用）: ${result.tunnel_address} (playit.gg 経由)`
          : `🚀 サーバーはオンラインです！ 接続用アドレス: ${result.tunnel_address} (serveo.net 経由)`
        );
      } else {
        addClientLog('failed', 'エラー: ローカル起動はデスクトップアプリ(Tauri)内でのみ実行可能です。');
        throw new Error('TAURI_REQUIRED: Webブラウザからはローカル起動を実行できません。');
      }
      await fetchActiveServer(true);
    } catch (err: any) {
      const rawMsg: string = err.message || String(err);
      const isCancel = rawMsg.includes('LaunchCancelled');
      const friendlyMsg = isCancel ? 'ユーザーによってサーバー構築がキャンセルされました。' : parseErrorMessage(rawMsg);
      
      if (isCancel) {
        addClientLog('stopped', `⚠️ 停止完了: ${friendlyMsg}`);
      } else {
        addClientLog('failed', `❌ エラー: ${friendlyMsg}`);
      }

      // エラー発生時、もしDB上にセッションレコードがすでに作られていれば、DB側にも失敗ログと失敗ステータスを書き込む
      if (createdSession) {
        try {
          await apiFetch('/api/servers/session', {
            method: 'PUT',
            body: JSON.stringify({
              sessionId: createdSession.id,
              status: isCancel ? 'stopped' : 'failed',
              cloudProvider: 'local',
              reason: isCancel
                ? `[停止完了] ユーザーによってサーバー構築がキャンセルされました。`
                : `[ERROR] サーバーの起動に失敗しました。理由: ${friendlyMsg}`
            }),
          });
        } catch (dbErr) {
          console.error('Failed to write failure log to DB:', dbErr);
        }
      }

      if (isCancel) {
        setLaunchError(null);
      } else if (rawMsg.includes('JAVA_NOT_FOUND')) {
        setLaunchError('java');
      } else if (rawMsg.includes('TAURI_REQUIRED')) {
        setLaunchError('tauri_required');
      } else {
        setLaunchError(friendlyMsg);
      }
    } finally {
      setLaunching(false);
      if (launchError) setLaunchProgress(0);
      if (unlistenProgress) {
        unlistenProgress();
      }
      await fetchActiveServer(false);
    }
  };

  const handleStop = async () => {
    if (!activeSession) return;
    if (!confirm('本当にこのサーバーを停止しますか？')) return;
    try {
      setStopping(true);

      if (isTauri) {
        const tauri = (window as unknown as TauriWindow).__TAURI__;
        if (tauri) {
          try {
            // Rust側のプロセスを安全に kill (プロセスが存在しない場合もエラーを無視してDB更新を続行します)
            await tauri.invoke('stop_server', { sessionId: activeSession.id });
          } catch (rustErr) {
            console.warn('Rust stop_server failed (likely no active process):', rustErr);
          }
        }
        
        // DBの状態を stopped に更新
        await apiFetch('/api/servers/session', {
          method: 'PUT',
          body: JSON.stringify({
            sessionId: activeSession.id,
            status: 'stopped'
          }),
        });
      } else {
        await apiFetch('/api/servers/stop', {
          method: 'POST',
        });
      }
      await fetchActiveServer(true);
    } catch (err: any) {
      alert(`サーバー停止エラー: ${err.message}`);
    } finally {
      setStopping(false);
    }
  };


  // ステータスに応じた進捗計算
  const getProgress = (status: string) => {
    switch (status) {
      case 'queued': return { percent: 15, label: 'キュー待機中' };
      case 'provisioning': return { percent: 45, label: 'インスタンス初期化中' };
      case 'fallback': return { percent: 65, label: '予備プロバイダーでリトライ中' };
      case 'running': return { percent: 100, label: '正常稼働中' };
      case 'warning_sent': return { percent: 100, label: '無人自動停止予告中' };
      case 'stopping': return { percent: 80, label: 'サーバーシャットダウン中' };
      case 'stopped': return { percent: 0, label: '停止済み' };
      case 'failed': return { percent: 0, label: '起動失敗' };
      default: return { percent: 0, label: '不明なステータス' };
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'queued':
        return <span className="badge3d" style={{ background: '#f59e0b', color: '#ffffff' }}>QUEUED</span>;
      case 'provisioning':
      case 'fallback':
        return <span className="badge3d" style={{ background: '#3b82f6', color: '#ffffff' }}>PROVISIONING</span>;
      case 'running':
        return <span className="badge3d" style={{ background: '#10b981', color: '#ffffff' }}>ONLINE</span>;
      case 'warning_sent':
        return <span className="badge3d" style={{ background: '#f59e0b', color: '#ffffff' }}>WARNING</span>;
      case 'stopping':
        return <span className="badge3d" style={{ background: '#6366f1', color: '#ffffff' }}>STOPPING</span>;
      case 'failed':
        return <span className="badge3d" style={{ background: '#ef4444', color: '#ffffff' }}>FAILED</span>;
      default:
        return <span className="badge3d" style={{ background: '#6b7280', color: '#ffffff' }}>UNKNOWN</span>;
    }
  };

  const formatLogTime = (timeStr: string) => {
    try {
      const date = new Date(timeStr);
      return date.toLocaleTimeString('ja-JP', { hour12: false });
    } catch {
      return '00:00:00';
    }
  };

  const getLogColorAndContent = (log: StatusLog) => {
    const time = formatLogTime(log.transitioned_at);
    // client-log や rust-log のIDが付いたものは reason をそのまま表示
    if (log.id.startsWith('client-log-') || log.id.startsWith('rust-log-')) {
      const reason = log.reason || '';
      let color = '#55ff55';
      if (reason.includes('❌') || reason.includes('エラー') || reason.includes('ERROR') || reason.includes('failed')) color = '#ef4444';
      else if (reason.includes('✔️') || reason.includes('🚀')) color = '#55ffff';
      else if (reason.includes('Warning') || reason.includes('⚠️')) color = '#ffcf40';
      else if (reason.startsWith('[Minecraft Server]')) color = '#a3d95d';
      else if (reason.startsWith('[SSH Tunnel]')) color = '#60a5fa';
      return { color, text: `[${time}] ${reason}` };
    }
    switch (log.to_status) {
      case 'queued':
        return { color: '#ffcf40', text: `[${time}] INFO: Launch request queued. Reason: ${log.reason || 'User triggered'}` };
      case 'provisioning':
        return { color: '#55ff55', text: `[${time}] INFO: Provisioning started. Accessing cloud compute resource...` };
      case 'fallback':
        return { color: '#ffcf40', text: `[${time}] WARN: Primary provider failed (Capacity limit). Trying fallback provider...` };
      case 'running':
        return { color: '#55ffff', text: `[${time}] SYNC: Server is running. Port 25565 opened. Tunnel established!` };
      case 'warning_sent':
        return { color: '#ffcf40', text: `[${time}] WARN: Server is empty. Auto-shutdown warning sent.` };
      case 'stopping':
        return { color: '#6366f1', text: `[${time}] INFO: Initiating server graceful shutdown...` };
      case 'stopped':
        return { color: '#9ca3af', text: `[${time}] INFO: Server stopped. Cloud resources destroyed.` };
      case 'failed':
        return { color: '#ef4444', text: `[${time}] ERROR: Fatal error during provision. Reason: ${log.reason || 'Unknown error'}` };
      default:
        return { color: '#ffffff', text: `[${time}] INFO: Status transitioned to ${log.to_status}` };
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh', color: '#ffffff', fontFamily: 'Inter, sans-serif' }}>
        <p>サーバー状況を読み込み中...</p>
      </div>
    );
  }

  // 起動中は launchProgress を優先表示。完了後は DB ステータスに基づく値を使用。
  const dbProgress = activeSession ? getProgress(activeSession.status) : { percent: 0, label: '未起動' };
  const percent = launching ? launchProgress : dbProgress.percent;
  const label = launching ? '起動処理中...' : dbProgress.label;

  return (
    <div>
      {zombieProcess && (
        <GlassCard variant="stone" style={{ border: '2px solid rgba(239, 68, 68, 0.6)', padding: '1.5rem', marginBottom: '2rem', textAlign: 'left' }}>
          <h4 style={{ color: '#ef4444', margin: '0 0 0.5rem 0', fontFamily: 'DotGothic16, sans-serif', fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            ⚠️ バックグラウンド競合（ゾンビプロセス）を検出しました
          </h4>
          <p style={{ color: '#e5e7eb', fontSize: '0.9rem', margin: '0 0 1rem 0', lineHeight: '1.6', fontFamily: 'Inter, sans-serif' }}>
            ポート 25565 がすでに他のプロセスによって使用されています。前回の Minecraft サーバー（Java）が正常に終了せず、バックグラウンドに残っている可能性があります（PID: {zombieProcess.pid || '不明'}）。この状態では新規サーバーを起動できません。
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <Button 
              variant="secondary" 
              style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#ffffff' }}
              onClick={async () => {
                if (zombieProcess.pid) {
                  try {
                    const tauri = (window as unknown as TauriWindow).__TAURI__;
                    if (tauri) {
                      await tauri.invoke('kill_zombie_process', { pid: zombieProcess.pid });
                      alert('プロセスを強制終了しました。');
                      setZombieProcess(null);
                    }
                  } catch (err) {
                    alert(`強制終了エラー: ${err}`);
                  }
                } else {
                  alert('PIDが特定できないため、タスクマネージャーから手動で java.exe を終了してください。');
                }
              }}
            >
              ゾンビプロセスを強制終了する
            </Button>
            <Button variant="secondary" onClick={() => setZombieProcess(null)}>
              閉じる
            </Button>
          </div>
        </GlassCard>
      )}

      <div style={{ marginBottom: '2.5rem' }}>
        <h2>サーバー監視</h2>
        <p style={{ color: '#9ca3af', marginTop: '0.6rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
          現在稼働中のサーバーインスタンスとログを確認します。
        </p>
      </div>

      {/* 不足MOD補完完了通知バナー */}
      {resolvedBanner && (
        <div style={{
          marginBottom: '1.8rem',
          padding: '1rem 1.3rem',
          background: 'rgba(52, 211, 153, 0.16)',
          border: '1px solid #34d399',
          borderRadius: '8px',
          color: '#34d399',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 4px 14px rgba(52, 211, 153, 0.15)',
        }}>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>🎉</span> 不足していたMODを補完しました（{resolvedBanner.count}件）
            </div>
            <div style={{ fontSize: '0.88rem', color: '#a7f3d0', marginTop: '0.35rem', lineHeight: '1.4' }}>
              構成へ追加完了: <strong>{resolvedBanner.names.join(', ')}</strong>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setResolvedBanner(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#a7f3d0',
              cursor: 'pointer',
              fontSize: '1.2rem',
              padding: '0.2rem 0.5rem',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {activeSession ? (
        <GlassCard variant="grass" style={{ marginBottom: '2.5rem', padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1.5rem' }}>
            <div style={{ flex: '1 1 280px', minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1.2rem', marginBottom: '1.5rem' }}>
                {getStatusBadge(activeSession.status)}
                <h3 style={{ fontSize: '1.40rem', margin: 0, color: '#a3d95d', fontWeight: 'bold', textShadow: '0 0 8px rgba(163, 217, 93, 0.4)' }}>
                  {label}
                </h3>
              </div>

              <p style={{ color: '#9ca3af', marginBottom: '0.6rem', fontFamily: 'Inter, sans-serif', fontSize: '0.95rem', fontWeight: '500', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                対象プリセット: <strong style={{ color: '#ffffff', fontWeight: 'bold' }}>{activeSession.presetName}</strong>
              </p>
              <p style={{ color: '#9ca3af', marginBottom: '0.6rem', fontFamily: 'Inter, sans-serif', fontSize: '0.95rem', fontWeight: '500' }}>
                バージョン: <strong style={{ color: '#ffffff', fontWeight: 'bold' }}>{activeSession.mcVersion} ({activeSession.loader})</strong>
              </p>
              <p style={{ color: '#9ca3af', marginBottom: '0.6rem', fontFamily: 'Inter, sans-serif', fontSize: '0.95rem', fontWeight: '500' }}>
                プロバイダー: <strong style={{ color: '#ffffff', fontWeight: 'bold' }}>
                  {activeSession.providerInfo}
                </strong>
              </p>
              
              {activeSession.status === 'running' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
                  <div style={{ padding: '0.75rem 1rem', background: 'rgba(0, 0, 0, 0.4)', borderRadius: '6px', border: '1px solid rgba(163, 217, 93, 0.3)' }}>
                    <p style={{ color: '#a3d95d', fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '0.2rem', fontFamily: 'DotGothic16, sans-serif' }}>
                      🔗 サーバー接続アドレス
                    </p>
                    <code style={{ fontSize: '1.15rem', color: '#ffffff', fontFamily: 'VT323, monospace', letterSpacing: '0.05em', wordBreak: 'break-all' }}>
                      {activeSession.connectionAddress || 'localhost:25565'}
                    </code>
                  </div>

                  {globalIp && (
                    <div style={{ padding: '0.75rem 1rem', background: 'rgba(0, 0, 0, 0.4)', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.15)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ color: '#a3d95d', fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '0.2rem', fontFamily: 'DotGothic16, sans-serif' }}>
                            🌐 直接接続用グローバルIPアドレス (ポート開放時)
                          </p>
                          <code style={{ fontSize: '1.15rem', color: '#ffffff', fontFamily: 'VT323, monospace', letterSpacing: '0.05em', wordBreak: 'break-all' }}>
                            {globalIp}:25565
                          </code>
                        </div>
                        <Button 
                          variant="secondary" 
                          style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', borderColor: 'rgba(255, 255, 255, 0.3)', color: '#ffffff' }}
                          onClick={() => {
                            navigator.clipboard.writeText(`${globalIp}:25565`);
                            alert('IPアドレスをコピーしました！');
                          }}
                        >
                          コピー
                        </Button>
                      </div>
                    </div>
                  )}

                  {zipPath && (
                    <div style={{ padding: '0.75rem 1rem', background: 'rgba(59, 130, 246, 0.15)', borderRadius: '6px', border: '1px solid rgba(59, 130, 246, 0.4)' }}>
                      <p style={{ color: '#60a5fa', fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '0.2rem', fontFamily: 'DotGothic16, sans-serif' }}>
                        📦 友達共有用MODパック（解決策B）
                      </p>
                      <p style={{ fontSize: '0.85rem', color: '#e5e7eb', margin: 0, lineHeight: '1.5', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        デスクトップに友達配布用ZIPが生成されました！<br />
                        ファイル: <code style={{ color: '#60a5fa', fontWeight: 'bold' }}>{zipPath.split(/[\\/]/).pop()}</code><br />
                        このZIPファイルを友達にDiscordなどで共有してください。
                      </p>
                    </div>
                  )}

                  {/* 🧪 稼働中サーバーへのクライアント入室Handshakeテスト結果 */}
                  {isTauri && (
                    <div style={{
                      padding: '0.75rem 1rem',
                      background: handshakeResult?.reachable ? 'rgba(16, 185, 129, 0.14)' : 'rgba(245, 158, 11, 0.14)',
                      borderRadius: '6px',
                      border: `1px solid ${handshakeResult?.reachable ? 'rgba(16, 185, 129, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '1rem',
                      flexWrap: 'wrap',
                    }}>
                      <div>
                        <p style={{ color: handshakeResult?.reachable ? '#34d399' : '#fbbf24', fontSize: '0.88rem', fontWeight: 'bold', marginBottom: '0.2rem', fontFamily: 'DotGothic16, sans-serif' }}>
                          {handshakeResult?.reachable ? '🟢 クライアント入室テスト（Handshake Ping）合格' : '⏳ クライアント入室疎通テスト'}
                        </p>
                        <p style={{ fontSize: '0.82rem', color: '#e5e7eb', margin: 0 }}>
                          {handshakeResult ? handshakeResult.message : '構築したサーバー (127.0.0.1:25565) へのクライアント接続を確認できます。'}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        disabled={testingHandshake}
                        onClick={handleTestClientHandshake}
                        style={{ padding: '0.3rem 0.75rem', fontSize: '0.78rem', borderColor: 'rgba(255,255,255,0.25)', color: '#fff' }}
                      >
                        {testingHandshake ? 'テスト中...' : '🔄 入室テスト再実行'}
                      </Button>
                    </div>
                  )}
                </div>
              )}

            </div>
            
            <Button 
              variant="secondary" 
              onClick={handleStop}
              disabled={stopping || activeSession.status === 'stopping'}
              style={{ color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.4)', textShadow: 'none' }}
            >
              {stopping ? '停止中...' : '強制停止'}
            </Button>
          </div>

          {/* Dynamic high-readability neon-green progress bar */}
          <div style={{ marginTop: '2.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem', fontSize: '1rem', fontFamily: 'DotGothic16, sans-serif', fontWeight: 'bold' }}>
              <span style={{ color: '#9ca3af' }}>{label}</span>
              <span style={{ color: '#a3d95d', fontFamily: 'VT323, monospace', fontSize: '1.4rem', fontWeight: 'bold' }}>{percent}%</span>
            </div>
            <div style={{ 
              height: '22px', 
              background: 'rgba(18, 20, 26, 0.65)', 
              border: '1px solid rgba(255, 255, 255, 0.15)', 
              borderRadius: '6px',
              overflow: 'hidden', 
              boxShadow: 'inset 2px 2px 4px rgba(0, 0, 0, 0.5)' 
            }}>
              <div style={{ 
                width: `${percent}%`, 
                height: '100%', 
                background: 'linear-gradient(90deg, var(--color-minecraft-grass-light), var(--color-minecraft-grass))', 
                boxShadow: 'inset 0 2px 0px rgba(255, 255, 255, 0.4), 0 0 8px rgba(163, 217, 93, 0.6)',
                transition: 'width 0.5s ease-in-out'
              }}></div>
            </div>
          </div>
        </GlassCard>
      ) : (
        <GlassCard variant="stone" style={{ marginBottom: '2.5rem', padding: '2.5rem', textAlign: 'center' }}>
          <div style={{ maxWidth: '500px', margin: '0 auto' }}>
            <h3 style={{ fontSize: '1.35rem', marginBottom: '1rem', color: '#ffffff', fontWeight: 'bold', fontFamily: 'DotGothic16, sans-serif' }}>
              現在起動中のサーバーはありません
            </h3>
            <p style={{ color: '#9ca3af', marginBottom: '2rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
              マイクラサーバーを動かすには、登録されているプリセットを選択して「サーバーを起動」ボタンを押してください。
            </p>
            
            {launchError && (
              <div style={{
                marginBottom: '1.25rem',
                padding: '1rem 1.25rem',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                borderRadius: '8px',
                textAlign: 'left',
              }}>
                {launchError === 'java' ? (
                  <>
                    <p style={{ color: '#ef4444', fontWeight: 'bold', marginBottom: '0.4rem', fontFamily: 'DotGothic16, sans-serif' }}>
                      ☕️ Java が見つからないか不足しています
                    </p>
                    <p style={{ color: '#fca5a5', fontSize: '0.9rem', fontFamily: 'Inter, sans-serif', lineHeight: '1.6' }}>
                      ローカルJava直起動サーバーを動かすには <strong>Java Runtime Environment (JRE)</strong> が必要です。<br />
                      1.21全バージョンに対応するため、<strong>Java 21 以上</strong> を推奨します。<br />
                      <a href="https://adoptium.net/" target="_blank" rel="noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline', fontWeight: 'bold' }}>Adoptium OpenJDK</a> などから最新の Java をインストールし、アプリを再起動してください。
                    </p>
                  </>
                ) : launchError === 'tauri_required' ? (
                  <>
                    <p style={{ color: '#ef4444', fontWeight: 'bold', marginBottom: '0.4rem', fontFamily: 'DotGothic16, sans-serif' }}>
                      🖥️ 専用デスクトップアプリ (Tauri) が必要です
                    </p>
                    <p style={{ color: '#fca5a5', fontSize: '0.9rem', fontFamily: 'Inter, sans-serif', lineHeight: '1.6' }}>
                      ローカルJava直起動サーバーを動かすには、MSIaaSのデスクトップアプリ（exe）内で動作させる必要があります。<br />
                      Webブラウザ環境からは直接PC内のJavaプロセスを起動できません。デスクトップアプリを起動して本画面を開いてください。
                    </p>
                  </>
                ) : (
                  <p style={{ color: '#ef4444', fontSize: '0.9rem', fontFamily: 'Inter, sans-serif', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                    ⚠️ 起動エラー: {launchError}
                  </p>
                )}
              </div>
            )}

            {presets.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'stretch' }}>
                <div style={{
                  padding: '0.6rem 1rem',
                  background: 'rgba(163, 217, 93, 0.12)',
                  border: '1px solid rgba(163, 217, 93, 0.3)',
                  borderRadius: '6px',
                  textAlign: 'left',
                  fontSize: '0.9rem',
                  color: '#a3d95d',
                  fontFamily: 'Inter, sans-serif',
                  fontWeight: '500'
                }}>
                  🖥️ <strong>対応バージョン: 1.21まで対応</strong><br />
                  <span style={{ color: '#d1d5db', fontSize: '0.82rem' }}>
                    ※1.18未満の古いバージョンも起動可能ですが、動作させるマインクラフトバージョンに応じた適切なJavaが必要です。
                  </span>
                </div>

                <select 
                  value={launchingPresetId} 
                  onChange={(e) => setLaunchingPresetId(e.target.value)}
                  style={{
                    backgroundColor: 'rgba(18, 20, 26, 0.8)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '6px',
                    padding: '0.75rem 1rem',
                    fontSize: '1rem',
                    fontFamily: 'Inter, sans-serif'
                  }}
                >
                  {presets.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.mc_version})</option>
                  ))}
                </select>
                <Button 
                  variant="primary" 
                  onClick={() => handleLaunch()}
                  disabled={launching || !launchingPresetId}
                  style={{ width: '100%', padding: '1rem' }}
                >
                  {launching ? '起動プロセス開始中...' : '🚀 選択したプリセットで起動'}
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
                <p style={{ color: '#ef4444', fontWeight: '500' }}>サーバーを起動するためのプリセットが登録されていません。</p>
                <Button variant="primary" href="/dashboard/presets">
                  プリセット一覧へ移動する
                </Button>
              </div>
            )}
          </div>
        </GlassCard>
      )}
      
      {activeSession && activeSession.status === 'running' && (
        <div style={{ 
          display: 'flex', 
          flexWrap: 'wrap',
          gap: '0.75rem', 
          marginBottom: '2rem', 
          padding: '1.25rem', 
          background: 'rgba(18, 20, 26, 0.75)', 
          border: '1px solid rgba(163, 217, 93, 0.3)', 
          borderRadius: '8px',
          alignItems: 'center',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
        }}>
          <span style={{ color: '#a3d95d', fontSize: '0.95rem', fontWeight: 'bold', fontFamily: 'DotGothic16, sans-serif', whiteSpace: 'nowrap' }}>
            🖥️ サーバーコマンド送信:
          </span>
          <input 
            type="text" 
            placeholder="op username, weather clear, say hello など (/は不要)" 
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            onKeyDown={async (e) => { 
              if (e.key === 'Enter') {
                if (!cmdInput || !activeSession) return;
                try {
                  if (isTauri) {
                    const tauri = (window as unknown as TauriWindow).__TAURI__;
                    if (tauri) {
                      await tauri.invoke('send_server_command', { 
                        sessionId: activeSession.id, 
                        command: cmdInput 
                      });
                      const virtualLog = {
                        id: `client-log-${Date.now()}-${Math.random()}`,
                        session_id: activeSession.id,
                        from_status: null,
                        to_status: 'running',
                        reason: `[コマンド送信] > ${cmdInput}`,
                        transitioned_at: new Date().toISOString()
                      };
                      setLogs(prev => [...prev, virtualLog]);
                      setCmdInput('');
                    }
                  }
                } catch (err) {
                  alert(`コマンド送信に失敗しました: ${err}`);
                }
              }
            }}
            style={{
              flex: '1 1 200px',
              minWidth: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              color: '#ffffff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              padding: '0.6rem 1rem',
              fontFamily: 'monospace',
              fontSize: '0.95rem'
            }}
          />
          <Button 
            variant="primary" 
            style={{ padding: '0.6rem 1.25rem' }}
            onClick={async () => {
              if (!cmdInput || !activeSession) return;
              try {
                if (isTauri) {
                  const tauri = (window as unknown as TauriWindow).__TAURI__;
                  if (tauri) {
                    await tauri.invoke('send_server_command', { 
                      sessionId: activeSession.id, 
                      command: cmdInput 
                    });
                    const virtualLog = {
                      id: `client-log-${Date.now()}-${Math.random()}`,
                      session_id: activeSession.id,
                      from_status: null,
                      to_status: 'running',
                      reason: `[コマンド送信] > ${cmdInput}`,
                      transitioned_at: new Date().toISOString()
                    };
                    setLogs(prev => [...prev, virtualLog]);
                    setCmdInput('');
                  }
                }
              } catch (err) {
                alert(`コマンド送信に失敗しました: ${err}`);
              }
            }}
          >
            送信
          </Button>
        </div>
      )}

      <h3 style={{ marginBottom: '1.2rem', color: '#ffffff', fontFamily: 'DotGothic16, sans-serif' }}>システムログ</h3>
      
      {/* High-end glassy neon terminal console with pixel borders */}
      <div style={{
        backgroundColor: 'rgba(18, 20, 26, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '4px solid #555555',
        borderImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'6\' height=\'6\'><rect x=\'2\' y=\'2\' width=\'2\' height=\'2\' fill=\'%23555555\'/></svg>") 2 repeat',
        padding: '1.75rem 2rem',
        boxShadow: 'inset 3px 3px 6px rgba(0, 0, 0, 0.8), inset -2px -2px 0px rgba(255, 255, 255, 0.1)',
        fontFamily: 'VT323, monospace',
        fontSize: '1.25rem',
        letterSpacing: '0.08em',
        borderRadius: '0 !important',
        maxHeight: '300px',
        overflowY: 'auto'
      }}>
        {logs.length > 0 ? (
          logs.map((log) => {
            const { color, text } = getLogColorAndContent(log);
            return (
              <div 
                key={log.id} 
                style={{ 
                  color, 
                  marginBottom: '0.6rem', 
                  whiteSpace: 'pre-line',
                  textShadow: color !== '#9ca3af' ? `0 0 6px ${color}80` : 'none' 
                }}
              >
                {text}
              </div>
            );
          })
        ) : (
          <div style={{ color: '#9ca3af', marginBottom: '0.2rem' }}>[00:00:00] 等待中（ログなし）...</div>
        )}
        
        {activeSession && activeSession.status !== 'running' && activeSession.status !== 'failed' && (
          <div style={{ color: '#9ca3af', marginBottom: '0.2rem', animation: 'pulse 1.5s infinite' }}>
            {`[${new Date().toLocaleTimeString('ja-JP', { hour12: false })}] 等待中...`}
          </div>
        )}
        <div ref={consoleEndRef} />
      </div>

      {/* 🛡️ サーバー起動前 MOD Side 確認モーダル (Step 3: UI確認画面) */}
      {preLaunchModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.78)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1100,
          padding: '1.5rem'
        }}>
          <GlassCard variant="stone" style={{ width: '100%', maxWidth: '800px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: '2.2rem', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '1rem', marginBottom: '1.2rem' }}>
              <div>
                <h3 style={{ fontSize: '1.35rem', color: '#ffffff', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <span>🛡️</span> サーバー起動前 MOD Side 確認
                </h3>
                <p style={{ color: '#9ca3af', fontSize: '0.88rem', marginTop: '0.4rem', fontFamily: 'Inter, sans-serif' }}>
                  プリセット「<strong>{preLaunchModal.presetName}</strong>」({preLaunchModal.mcVersion} / {preLaunchModal.loader}) のサーバー起動前に、<code>mods/</code> へ配置するMODを確認します。
                </p>
              </div>
              <button
                onClick={() => setPreLaunchModal(null)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.4rem', paddingRight: '0.4rem' }}>
              {/* ⏳ MOD解析中の進捗表示（解析はバックグラウンドで行われるため、この間もUIは操作可能） */}
              {sandboxScanning && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.7rem',
                  background: 'rgba(56, 189, 248, 0.1)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  borderRadius: '8px',
                  padding: '0.85rem 1.1rem',
                  color: '#bae6fd',
                  fontSize: '0.86rem',
                }}>
                  <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
                  <div>
                    <div style={{ fontWeight: 'bold' }}>サンドボックス検証を実行中です（MOD {preLaunchModal.allMods.length} 件）</div>
                    <div style={{ color: '#9ca3af', fontSize: '0.78rem', marginTop: '0.15rem' }}>
                      {modScanProgress || 'JARメタデータを並列解析しています...'}
                    </div>
                  </div>
                </div>
              )}

              {/* 🔄 構成追加・自動補完中のローディングプログレス表示 */}
              {resolvingMissing && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.8rem',
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.5)',
                  borderRadius: '8px',
                  padding: '0.95rem 1.2rem',
                  color: '#bae6fd',
                  fontSize: '0.88rem',
                }}>
                  <span style={{ display: 'inline-block', fontSize: '1.25rem', animation: 'spin 1s linear infinite' }}>🔄</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', color: '#38bdf8' }}>構成を追加・更新しています...</div>
                    <div style={{ color: '#93c5fd', fontSize: '0.82rem', marginTop: '0.2rem' }}>
                      {resolveProgressText || 'Modrinth / CurseForge から不足MODを検索・解決中...'}
                    </div>
                  </div>
                </div>
              )}

              {/* 🧪 サンドボックス互換診断 & クライアント入室テスト結果 */}
              {sandboxReport && (
                <div style={{
                  background: (sandboxReport.server_ready && sandboxReport.client_join_ready)
                    ? 'rgba(16, 185, 129, 0.08)'
                    : 'rgba(245, 158, 11, 0.1)',
                  border: `1px solid ${(sandboxReport.server_ready && sandboxReport.client_join_ready) ? 'rgba(16, 185, 129, 0.35)' : 'rgba(245, 158, 11, 0.4)'}`,
                  borderRadius: '8px',
                  padding: '1rem 1.15rem',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', marginBottom: '0.55rem' }}>
                    <span style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '0.96rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      🧪 サンドボックス検証（サーバー起動 ＆ クライアント入室互換性）
                    </span>
                    <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: '0.75rem',
                        padding: '0.18rem 0.6rem',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                        background: sandboxReport.server_ready ? 'rgba(16, 185, 129, 0.22)' : 'rgba(245, 158, 11, 0.25)',
                        color: sandboxReport.server_ready ? '#34d399' : '#fbbf24',
                      }}>
                        {sandboxReport.server_ready ? '🟢 サーバー起動準備OK' : '⚠️ サーバー前提MOD・URL要補完'}
                      </span>
                      <span style={{
                        fontSize: '0.75rem',
                        padding: '0.18rem 0.6rem',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                        background: sandboxReport.client_join_ready ? 'rgba(16, 185, 129, 0.22)' : 'rgba(56, 189, 248, 0.2)',
                        color: sandboxReport.client_join_ready ? '#34d399' : '#38bdf8',
                      }}>
                        {sandboxReport.client_join_ready
                          ? `🟢 このPCで入室可能 (.minecraft/mods: ${sandboxReport.local_installed_count}/${sandboxReport.required_client_mods.length}件導入済)`
                          : `💻 クライアント必要MOD: ${sandboxReport.local_installed_count}/${sandboxReport.required_client_mods.length}件導入済`}
                      </span>
                    </div>
                  </div>

                  <p style={{ color: '#e5e7eb', fontSize: '0.84rem', margin: '0 0 0.75rem 0', lineHeight: '1.5' }}>
                    {sandboxReport.summary_message}
                  </p>

                  {/* 不足MOD補完完了通知バナー（モーダル内） */}
                  {resolvedBanner && (
                    <div style={{
                      marginBottom: '0.85rem',
                      padding: '0.75rem 1rem',
                      background: 'rgba(52, 211, 153, 0.16)',
                      border: '1px solid #34d399',
                      borderRadius: '8px',
                      color: '#34d399',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}>
                      <div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span>🎉</span> 不足MODを補完しました（{resolvedBanner.count}件）
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#a7f3d0', marginTop: '0.2rem' }}>
                          構成へ追加完了: {resolvedBanner.names.join(', ')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setResolvedBanner(null)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#a7f3d0',
                          cursor: 'pointer',
                          fontSize: '1rem',
                          padding: '0.1rem 0.4rem',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* 不足している前提MOD（サーバー側またはクライアント側にZIPファイルだけでは足りない場合の判定・注意文） */}
                  {sandboxReport.missing_prerequisites.length > 0 && (
                    <div style={{ marginBottom: '0.85rem', padding: '0.85rem 1rem', background: 'rgba(239, 68, 68, 0.12)', borderRadius: '8px', border: '1px solid rgba(248, 113, 113, 0.5)' }}>
                      <div style={{ color: '#fca5a5', fontSize: '0.88rem', fontWeight: 'bold', marginBottom: '0.45rem', lineHeight: '1.5' }}>
                        {sandboxReport.confirmation_prompt || '⚠️ サーバー側またはクライアント側にZIPファイルだけでは足りないMODが検出されました。以下のMODが足りないため、構成に入れてもかまいませんか？'}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', marginBottom: '0.65rem' }}>
                        {sandboxReport.missing_prerequisites.map((mp, idx) => {
                          const sideLabel =
                            mp.scope === 'both'
                              ? 'サーバー・クライアント双方で必須'
                              : mp.scope === 'server'
                              ? 'サーバー側で必須'
                              : 'クライアント側で必須';
                          return (
                            <span key={`${mp.mod_id}-${idx}`} style={{ fontSize: '0.78rem', background: 'rgba(0, 0, 0, 0.45)', color: '#fff', padding: '0.25rem 0.65rem', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.5)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                              <strong style={{ color: '#fde68a' }}>{mp.mod_id}</strong>{' '}
                              <span style={{ color: '#d1d5db' }}>({sideLabel} / 要求元: {mp.required_by})</span>{' '}
                              {mp.available_locally ? (
                                <span style={{ color: '#34d399', fontWeight: 'bold' }}>[PC内検出: {mp.local_jar_name || '導入可能'}]</span>
                              ) : (
                                <span style={{ color: '#38bdf8' }}>[Modrinth/CF自動取得]</span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleOpenInAppSearch(mp.mod_id)}
                                title="アプリ内で別名やキーワードで手動検索して追加"
                                style={{
                                  background: 'rgba(56, 189, 248, 0.2)',
                                  border: '1px solid rgba(56, 189, 248, 0.5)',
                                  color: '#38bdf8',
                                  borderRadius: '3px',
                                  padding: '0.1rem 0.45rem',
                                  cursor: 'pointer',
                                  fontSize: '0.72rem',
                                  marginLeft: '0.25rem',
                                }}
                              >
                                🔍 手動検索
                              </button>
                              <button
                                type="button"
                                onClick={() => handleIgnoreMissingMod(mp.mod_id)}
                                title="MOD本体に内包済みのライブラリ、または不要なため不足判定から除外"
                                style={{
                                  background: 'rgba(239, 68, 68, 0.25)',
                                  border: '1px solid rgba(239, 68, 68, 0.5)',
                                  color: '#fca5a5',
                                  borderRadius: '3px',
                                  padding: '0.1rem 0.4rem',
                                  cursor: 'pointer',
                                  fontSize: '0.72rem',
                                  marginLeft: '0.15rem',
                                }}
                              >
                                ✕ 内包/不要除外
                              </button>
                            </span>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                        <Button
                          variant="primary"
                          disabled={resolvingMissing}
                          onClick={handleResolveMissingInModal}
                          style={{
                            padding: '0.45rem 0.95rem',
                            fontSize: '0.82rem',
                          }}
                        >
                          {resolvingMissing ? '🔄 構成に追加・補完中...' : '✅ はい、不足MODを構成に入れて補完する'}
                        </Button>
                        <span style={{ fontSize: '0.76rem', color: '#e5e7eb' }}>
                          ※このまま「サーバーを起動する」を押した場合も確認ダイアログから構成へ追加できます。
                        </span>
                      </div>
                    </div>
                  )}

                  {/* ⚠️ 外部API自動取得失敗時またはDL未解決MODの救済UI（missing_prerequisitesが0件になっても消えないよう独立配置） */}
                  {(() => {
                    const manualTargetMods = Array.from(
                      new Set([
                        ...failedSearchMods,
                        ...(sandboxReport.unresolved_mods || []),
                      ])
                    );
                    if (manualTargetMods.length === 0 && sandboxReport.missing_prerequisites.length === 0) {
                      return null;
                    }
                    return (
                      <div style={{ marginBottom: '0.85rem' }}>
                        {manualTargetMods.length > 0 && (
                          <div style={{ padding: '0.75rem', background: 'rgba(0, 0, 0, 0.45)', borderRadius: '6px', border: '1px solid rgba(248, 113, 113, 0.4)', marginBottom: '0.65rem' }}>
                            <div style={{ color: '#fca5a5', fontSize: '0.82rem', fontWeight: 'bold', marginBottom: '0.45rem' }}>
                              ⚠️ 以下のMODはWeb上から自動取得できませんでした。アプリ内検索で別名を検索するか、JARを直接追加してください：
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                              {manualTargetMods.map((modName) => (
                                <div key={modName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255, 255, 255, 0.04)', padding: '0.35rem 0.65rem', borderRadius: '4px', flexWrap: 'wrap', gap: '0.4rem' }}>
                                  <span style={{ color: '#fde68a', fontSize: '0.8rem', fontWeight: 'bold' }}>{modName}</span>
                                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                    <Button
                                      variant="secondary"
                                      onClick={() => handleOpenInAppSearch(modName)}
                                      style={{
                                        padding: '0.2rem 0.65rem',
                                        fontSize: '0.75rem',
                                        backgroundColor: 'rgba(56, 189, 248, 0.18)',
                                        borderColor: 'rgba(56, 189, 248, 0.45)',
                                        color: '#38bdf8'
                                      }}
                                    >
                                      🔍 アプリ内で手動検索して追加
                                    </Button>
                                    <button
                                      type="button"
                                      onClick={() => handleIgnoreMissingMod(modName)}
                                      title="MOD本体に内包されているか、サーバー起動に不要なため不足判定から除外"
                                      style={{
                                        padding: '0.22rem 0.6rem',
                                        fontSize: '0.75rem',
                                        backgroundColor: 'rgba(156, 163, 175, 0.18)',
                                        border: '1px solid rgba(156, 163, 175, 0.45)',
                                        borderRadius: '4px',
                                        color: '#d1d5db',
                                        cursor: 'pointer',
                                      }}
                                    >
                                      🚫 内包・不要として選別除外
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 📥 手持ちのJARファイルを直接ドロップして構成に追加できる枠 */}
                        <div
                          onDragOver={(e) => { e.preventDefault(); setIsDraggingJar(true); }}
                          onDragLeave={() => setIsDraggingJar(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setIsDraggingJar(false);
                            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                              handleDropCustomJar(e.dataTransfer.files[0]);
                            }
                          }}
                          style={{
                            border: `1px dashed ${isDraggingJar ? '#38bdf8' : 'rgba(255, 255, 255, 0.22)'}`,
                            background: isDraggingJar ? 'rgba(56, 189, 248, 0.12)' : 'rgba(0, 0, 0, 0.25)',
                            borderRadius: '6px',
                            padding: '0.55rem 0.8rem',
                            textAlign: 'center',
                            color: isDraggingJar ? '#38bdf8' : '#9ca3af',
                            fontSize: '0.78rem',
                            transition: 'all 0.2s',
                          }}
                        >
                          📥 手元にJARファイルがある場合は、ここにドラッグ＆ドロップしてプリセットに直接追加できます
                        </div>
                      </div>
                    );
                  })()}

                  {/* アクションボタン群 */}
                  <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
                    <Button
                      variant="secondary"
                      disabled={resolvingMissing}
                      onClick={handleResolveMissingInModal}
                      style={{
                        padding: '0.4rem 0.85rem',
                        fontSize: '0.8rem',
                        backgroundColor: 'rgba(245, 158, 11, 0.16)',
                        borderColor: 'rgba(245, 158, 11, 0.45)',
                        color: '#fde68a',
                        whiteSpace: 'normal',
                        textAlign: 'center',
                        lineHeight: 1.4,
                      }}
                    >
                      {resolvingMissing ? '🔄 Modrinthから検索・補完中...' : '🔍 不足している前提MOD・DLリンクを自動検索・補完'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => handleOpenInAppSearch('')}
                      style={{
                        padding: '0.4rem 0.85rem',
                        fontSize: '0.8rem',
                        backgroundColor: 'rgba(56, 189, 248, 0.16)',
                        borderColor: 'rgba(56, 189, 248, 0.45)',
                        color: '#38bdf8',
                        whiteSpace: 'normal',
                        textAlign: 'center',
                        lineHeight: 1.4,
                      }}
                    >
                      🔎 アプリ内でMODを手動検索して追加
                    </Button>
                    {isTauri && (
                      <Button
                        variant="secondary"
                        disabled={syncingLocalMods}
                        onClick={handleSyncClientModsToLocal}
                        style={{
                          padding: '0.4rem 0.85rem',
                          fontSize: '0.8rem',
                          backgroundColor: 'rgba(56, 189, 248, 0.16)',
                          borderColor: 'rgba(56, 189, 248, 0.45)',
                          color: '#38bdf8',
                          whiteSpace: 'normal',
                          textAlign: 'center',
                          lineHeight: 1.4,
                        }}
                      >
                        {syncingLocalMods ? '🔄 .minecraft/mods へ同期中...' : '🔄 このPCの .minecraft/mods に必要MODを一括同期'}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* 💻 クライアントが構築したサーバーに入るために必要なMOD一覧 */}
              {sandboxReport && sandboxReport.required_client_mods.length > 0 && (
                <div>
                  <h4 style={{ color: '#38bdf8', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.45rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>💻 クライアントがサーバーに入るために必要なMOD一覧 ({sandboxReport.required_client_mods.length}件)</span>
                    <span style={{ fontSize: '0.76rem', color: '#9ca3af', fontWeight: 'normal' }}>
                      ※「らくらくZIPパック」にも自動収録されます
                    </span>
                  </h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.45rem' }}>
                    <ChunkedList
                      items={sandboxReport.required_client_mods}
                      resetKey={preLaunchModal.presetId}
                      renderItem={(cm, idx) => (
                      <div key={`${cm.name}-${idx}`} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: cm.installed_in_local_client ? 'rgba(16, 185, 129, 0.08)' : 'rgba(56, 189, 248, 0.06)',
                        border: `1px solid ${cm.installed_in_local_client ? 'rgba(16, 185, 129, 0.28)' : 'rgba(56, 189, 248, 0.22)'}`,
                        borderRadius: '6px',
                        padding: '0.48rem 0.75rem',
                        gap: '0.5rem',
                      }}>
                        <div style={{ overflow: 'hidden' }}>
                          <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.84rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {cm.name}
                          </div>
                          <div style={{ color: '#9ca3af', fontSize: '0.72rem' }}>
                            {cm.side === 'both' ? '🔗 サーバー・クライアント共通必須' : '🎨 クライアント専用MOD'}
                          </div>
                        </div>
                        <span style={{
                          fontSize: '0.7rem',
                          whiteSpace: 'nowrap',
                          padding: '0.12rem 0.45rem',
                          borderRadius: '4px',
                          fontWeight: 'bold',
                          background: cm.installed_in_local_client
                            ? 'rgba(16, 185, 129, 0.22)'
                            : cm.can_auto_supply
                            ? 'rgba(56, 189, 248, 0.2)'
                            : 'rgba(239, 68, 68, 0.22)',
                          color: cm.installed_in_local_client
                            ? '#34d399'
                            : cm.can_auto_supply
                            ? '#38bdf8'
                            : '#f87171',
                        }}>
                          {cm.installed_in_local_client
                            ? '✓ .minecraft導入済'
                            : cm.can_auto_supply
                            ? 'DL・同期可能'
                            : 'URL要補完'}
                        </span>
                      </div>
                      )}
                    />
                  </div>
                </div>
              )}

              {/* 1. サーバーに追加されるMOD */}
              <div>
                <h4 style={{ color: '#34d399', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.6rem' }}>
                  ✅ サーバーに追加されるMOD ({preLaunchModal.serverMods.length}件)
                </h4>
                {preLaunchModal.serverMods.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>サーバーに追加されるMODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    <ChunkedList
                      items={preLaunchModal.serverMods}
                      resetKey={preLaunchModal.presetId}
                      renderItem={(m) => (
                      <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '6px', padding: '0.6rem 0.9rem' }}>
                        <div>
                          <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name}</div>
                          <div style={{ color: '#6ee7b7', fontSize: '0.78rem', marginTop: '0.12rem' }}>
                            {m.is_lightweight_pack === 1 ? '⚡ 軽量化パック自動注入 (サーバー対応)' : m.manually_added === 1 ? '📦 ユーザー指定MOD (サーバー対応)' : '🔗 前提MOD自動解決 (サーバー対応)'}
                          </div>
                        </div>
                        <span style={{ fontSize: '0.75rem', background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>SERVER</span>
                      </div>
                      )}
                    />
                  </div>
                )}
              </div>

              {/* 2. クライアント専用として除外されるMOD */}
              <div>
                <h4 style={{ color: '#f87171', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.6rem' }}>
                  🚫 クライアント専用として除外されるMOD ({preLaunchModal.clientOnlyMods.length}件)
                </h4>
                {preLaunchModal.clientOnlyMods.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>除外対象のクライアント専用MODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    <ChunkedList
                      items={preLaunchModal.clientOnlyMods}
                      resetKey={preLaunchModal.presetId}
                      renderItem={(m) => (
                      <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '6px', padding: '0.6rem 0.9rem' }}>
                        <div>
                          <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name}</div>
                          <div style={{ color: '#fca5a5', fontSize: '0.8rem', marginTop: '0.12rem' }}>
                            除外理由: クライアント専用MOD (server_side=unsupported / clientOnly) のためサーバーの mods/ から自動スキップします（ゲスト配布用ZIPには収録されます）。
                          </div>
                        </div>
                        <span style={{ fontSize: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>CLIENT ONLY</span>
                      </div>
                      )}
                    />
                  </div>
                )}
              </div>

              {/* 3. 判定不明のMOD（server / client / both トグル選択） */}
              <div>
                <h4 style={{ color: '#fbbf24', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.4rem' }}>
                  ❓ 判定不明のMOD ({preLaunchModal.unknownMods.length}件) — デフォルト除外
                </h4>
                {preLaunchModal.unknownMods.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>判定不明のMODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <ChunkedList
                      items={preLaunchModal.unknownMods}
                      resetKey={preLaunchModal.presetId}
                      renderItem={(m) => {
                        const currentChoice = unknownModChoices[m.name] || 'client';
                        return (
                          <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', background: 'rgba(245, 158, 11, 0.07)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: '6px', padding: '0.65rem 0.9rem', flexWrap: 'wrap' }}>
                            <div>
                              <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name}</div>
                              <div style={{ color: '#fcd34d', fontSize: '0.78rem', marginTop: '0.12rem' }}>
                                判定不明のためデフォルトは除外 (client) です。サーバーへ配置する場合は server または both を選択してください。
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              {(['client', 'server', 'both'] as ModSideToggleChoice[]).map((opt) => {
                                const active = currentChoice === opt;
                                const label = opt === 'client' ? 'client (除外)' : opt === 'server' ? 'server (追加)' : 'both (両方)';
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => setUnknownModChoices(prev => ({ ...prev, [m.name]: opt }))}
                                    style={{
                                      padding: '0.3rem 0.65rem',
                                      fontSize: '0.78rem',
                                      fontWeight: active ? 'bold' : 'normal',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      border: active ? '1px solid #a3d95d' : '1px solid rgba(255,255,255,0.15)',
                                      background: active ? 'rgba(163, 217, 93, 0.22)' : 'rgba(0,0,0,0.35)',
                                      color: active ? '#a3d95d' : '#9ca3af',
                                    }}
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.2rem', marginTop: '1.2rem' }}>
              <Button variant="secondary" onClick={() => setPreLaunchModal(null)}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={handleConfirmPreLaunchModal} disabled={sandboxScanning || resolvingMissing || syncingLocalMods}>
                {sandboxScanning ? '⏳ MOD解析中...' : '🚀 この構成でサーバーを起動'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* 🔍 アプリ内手動MOD検索・追加モーダル（自動取得で見つからなかったMODの救済UI） */}
      {inAppSearchMod && preLaunchModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1200,
          padding: '1.5rem',
        }}>
          <GlassCard variant="stone" style={{ width: '100%', maxWidth: '680px', maxHeight: '82vh', display: 'flex', flexDirection: 'column', padding: '2rem', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.2rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.8rem' }}>
              <div>
                <h3 style={{ fontSize: '1.2rem', color: '#ffffff', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>🔍</span> アプリ内でMODを手動検索して追加
                </h3>
                <p style={{ color: '#9ca3af', fontSize: '0.82rem', marginTop: '0.25rem' }}>
                  「<strong>{inAppSearchMod}</strong>」の正式名や関連キーワードで Modrinth / CurseForge を検索し、構成に追加します。
                </p>
              </div>
              <button
                onClick={() => setInAppSearchMod(null)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.4rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {/* 検索入力バー */}
            <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1.2rem' }}>
              <input
                type="text"
                value={inAppSearchQuery}
                onChange={(e) => setInAppSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleExecuteInAppSearch(inAppSearchQuery); }}
                placeholder="MOD名またはキーワードを入力..."
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(0, 0, 0, 0.45)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  padding: '0.55rem 0.9rem',
                  fontSize: '0.9rem',
                }}
              />
              <Button
                variant="primary"
                disabled={inAppSearching || !inAppSearchQuery.trim()}
                onClick={() => handleExecuteInAppSearch(inAppSearchQuery)}
                style={{ padding: '0.55rem 1.1rem', fontSize: '0.85rem' }}
              >
                {inAppSearching ? '検索中...' : '検索'}
              </Button>
            </div>

            {/* 検索結果一覧 */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.6rem', paddingRight: '0.3rem' }}>
              {inAppSearching ? (
                <div style={{ textAlign: 'center', padding: '2.5rem', color: '#9ca3af', fontSize: '0.88rem' }}>
                  🔄 Modrinth / CurseForge を検索中...
                </div>
              ) : inAppSearchResults.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2.5rem', color: '#9ca3af', fontSize: '0.85rem' }}>
                  該当するMODが見つかりませんでした。別のキーワード（英語名や正式名称）でお試しください。
                </div>
              ) : (
                inAppSearchResults.map((mod) => (
                  <div
                    key={mod.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '6px',
                      padding: '0.75rem 0.95rem',
                      gap: '0.7rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: '200px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
                        <span style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '0.92rem' }}>{mod.title}</span>
                        <span style={{
                          fontSize: '0.68rem',
                          background: mod.source === 'curseforge' ? 'rgba(239, 104, 38, 0.2)' : 'rgba(163, 217, 93, 0.2)',
                          color: mod.source === 'curseforge' ? '#ef6826' : '#a3d95d',
                          padding: '0.08rem 0.35rem',
                          borderRadius: '3px',
                          fontWeight: 'bold',
                          textTransform: 'uppercase'
                        }}>
                          {mod.source || 'modrinth'}
                        </span>
                        <span style={{
                          fontSize: '0.68rem',
                          background: mod.server_side === 'unsupported' ? 'rgba(245, 158, 11, 0.18)' : 'rgba(16, 185, 129, 0.18)',
                          color: mod.server_side === 'unsupported' ? '#fbbf24' : '#34d399',
                          padding: '0.08rem 0.35rem',
                          borderRadius: '3px',
                          fontWeight: '600'
                        }}>
                          {mod.server_side === 'unsupported' ? 'クライアント専用' : 'サーバー対応'}
                        </span>
                      </div>
                      <p style={{ color: '#9ca3af', fontSize: '0.78rem', margin: 0, lineHeight: '1.35' }}>
                        {mod.description || '説明はありません。'}
                      </p>
                    </div>
                    <Button
                      variant="primary"
                      disabled={inAppAdding}
                      onClick={() => handleInAppAddMod(mod)}
                      style={{ padding: '0.4rem 0.85rem', fontSize: '0.8rem' }}
                    >
                      {inAppAdding ? '追加中...' : '＋ このMODを追加'}
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '0.85rem', marginTop: '1rem' }}>
              <Button variant="secondary" onClick={() => setInAppSearchMod(null)}>
                閉じる
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}

export default function ServersPage() {
  return (
    <Suspense fallback={<div style={{ color: '#ffffff', textAlign: 'center', padding: '2rem' }}>読み込み中...</div>}>
      <ServersContent />
    </Suspense>
  );
}
