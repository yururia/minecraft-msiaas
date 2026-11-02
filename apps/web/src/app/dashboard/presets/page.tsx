'use client';

import React, { useEffect, useState, useRef } from 'react';
import { GlassCard } from '../../../components/GlassCard';
import { Button } from '../../../components/Button';
import { apiFetch } from '../../../lib/api';
import { useRouter } from 'next/navigation';
import { usePresetImport } from '../../../context/PresetImportContext';
import { scanAndFilterMods, ModScanResult, ModScanProgress } from '@msiaas/shared';
import JSZip from 'jszip';

const MOD_LIST_PAGE_SIZE = 40;

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

interface Preset {
  id: string;
  name: string;
  mc_version: string;
  loader: string;
  estimated_load: number;
  resource_profile: string;
  source?: string;
}

type UnknownToggleChoice = 'client' | 'server' | 'both';

interface PendingZipImportState {
  fileName: string;
  scanResult: ModScanResult;
  manifest: any | null;
  modrinthIndex: any | null;
  mcVersion: string;
  loader: string;
}

export default function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  
  // ZIP インポート用の状態管理 (UIドラッグ状態はローカルでOK)
  const [isDragging, setIsDragging] = useState(false);

  // MOD Side 判定・仕分け確認モーダル用の状態管理
  const [pendingZipImport, setPendingZipImport] = useState<PendingZipImportState | null>(null);
  const [unknownChoices, setUnknownChoices] = useState<Record<string, UnknownToggleChoice>>({});
  const [importProgress, setImportProgress] = useState<ModScanProgress | null>(null);

  // グローバルコンテキストからインポート状態を取得
  const {
    importing,
    importError,
    importSuccess,
    setImporting,
    setImportError,
    setImportSuccess
  } = usePresetImport();

  // 編集・削除用の状態管理
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [newPresetName, setNewPresetName] = useState('');
  const [updating, setUpdating] = useState(false);

  // MOD管理用の状態管理
  const [managingPreset, setManagingPreset] = useState<Preset | null>(null);
  const [presetMods, setPresetMods] = useState<any[]>([]);
  const [loadingMods, setLoadingMods] = useState(false);
  const [modActiveTab, setModActiveTab] = useState<'list' | 'search'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [updatingMods, setUpdatingMods] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const handleOpenModManager = async (preset: Preset) => {
    setManagingPreset(preset);
    setModActiveTab('list');
    setSearchQuery('');
    setSearchResults([]);
    try {
      setLoadingMods(true);
      const res = await apiFetch(`/api/presets/${preset.id}`);
      setPresetMods(res.mods || []);
    } catch (err: any) {
      console.error(err);
      alert('MODリストの取得に失敗しました。');
    } finally {
      setLoadingMods(false);
    }
  };

  const handleSearchMods = async () => {
    if (!searchQuery.trim() || !managingPreset) return;
    try {
      setSearching(true);
      const cleaned = searchQuery.trim().replace(/\.(jar|zip)$/i, '');
      const res = await apiFetch(
        `/api/mods/search?q=${encodeURIComponent(cleaned)}&mc_version=${managingPreset.mc_version}&loader=${managingPreset.loader}`
      );
      setSearchResults(res.mods || []);
    } catch (err: any) {
      console.error(err);
      alert('MOD検索に失敗しました。');
    } finally {
      setSearching(false);
    }
  };

  const handleAddMod = async (searchedMod: any) => {
    if (!managingPreset) return;
    try {
      setUpdatingMods(true);
      // 1. まずマスタDBに保存（キャッシュ）してIDを取得
      const cacheRes = await apiFetch('/api/mods', {
        method: 'POST',
        body: JSON.stringify({
          source: searchedMod.source || 'modrinth',
          external_id: searchedMod.id,
          name: searchedMod.title,
          mc_version: managingPreset.mc_version,
          loader: managingPreset.loader,
          license: searchedMod.license || 'Unknown',
          download_url: searchedMod.download_url || '',
          client_side: searchedMod.client_side || 'optional',
          server_side: searchedMod.server_side || 'optional',
        })
      });
      const newModUuid = cacheRes.id;

      // 2. 現在の手動追加MODのID配列を作成
      const currentManualIds = presetMods
        .filter(m => m.manually_added === 1)
        .map(m => m.id);

      if (currentManualIds.includes(newModUuid)) {
        alert('このMODはすでにプリセットに登録されています。');
        return;
      }

      const nextManualIds = [...currentManualIds, newModUuid];

      // 3. 構成を更新
      const updateRes = await apiFetch(`/api/presets/${managingPreset.id}/mods`, {
        method: 'PUT',
        body: JSON.stringify({ mod_ids: nextManualIds })
      });

      setPresetMods(updateRes.mods || []);
      await fetchPresets();
    } catch (err: any) {
      console.error(err);
      alert(`MOD追加エラー: ${err.message || '追加に失敗しました'}`);
    } finally {
      setUpdatingMods(false);
    }
  };

  const handleDeleteMod = async (modId: string) => {
    if (!managingPreset) return;
    if (!confirm('このMODを削除しますか？\n(このMODにのみ依存していた前提MODも自動で連鎖削除されます)')) return;
    try {
      setUpdatingMods(true);
      const nextManualIds = presetMods
        .filter(m => m.manually_added === 1 && m.id !== modId)
        .map(m => m.id);

      const updateRes = await apiFetch(`/api/presets/${managingPreset.id}/mods`, {
        method: 'PUT',
        body: JSON.stringify({ mod_ids: nextManualIds })
      });

      setPresetMods(updateRes.mods || []);
      await fetchPresets();
    } catch (err: any) {
      console.error(err);
      alert(`MOD削除エラー: ${err.message || '削除に失敗しました'}`);
    } finally {
      setUpdatingMods(false);
    }
  };

  const fetchPresets = async () => {
    try {
      setLoading(true);
      const data = await apiFetch('/api/presets');
      setPresets(data.presets || []);
      setError(null);
    } catch (err: any) {
      console.error(err);
      setError('プリセットの取得に失敗しました。APIサーバーが起動しているか確認してください。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPresets();

    // 画面外ドロップによるブラウザデフォルト動作（ファイルのロード等）を完全に防止
    const preventDefault = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
    };
  }, []);

  const handleLaunch = async (presetId: string) => {
    router.push(`/dashboard/servers?launchPresetId=${presetId}`);
  };

  const handleCreateDemoPreset = async () => {
    try {
      setLoading(true);
      // デモ用プリセットをAPI経由で作成
      await apiFetch('/api/presets', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Create 1.20.1 Forge Pack',
          mc_version: '1.20.1',
          loader: 'forge',
          mod_ids: [] // 空配列で依存関係解決＆軽量化パック注入のデモ動作
        }),
      });
      await fetchPresets();
    } catch (err: any) {
      alert(`デモプリセット作成エラー: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 既存プリセットの不足前提MOD・URL未解決MODを自動検索・補完
  const handleResolveMissingForPreset = async (presetId: string, missingModIds: string[] = []) => {
    try {
      setUpdatingMods(true);
      const res = await apiFetch(`/api/presets/${presetId}/resolve-missing`, {
        method: 'POST',
        body: JSON.stringify({ missingModIds }),
      });
      if (managingPreset && managingPreset.id === presetId) {
        setPresetMods(res.mods || []);
      }
      await fetchPresets();
      const addedCount = res.resolvedMods?.length || 0;
      alert(
        addedCount > 0
          ? `✅ 不足していた前提MOD / ダウンロードURLを ${addedCount} 件自動補完しました！\n(${res.resolvedMods.map((m: any) => m.name).join(', ')})`
          : 'すべてのMODのダウンロードURLと前提MODが解決済み、または追加対象はありませんでした。'
      );
    } catch (err: any) {
      alert(`自動補完エラー: ${err.message}`);
    } finally {
      setUpdatingMods(false);
    }
  };

  // MOD Side 確認モーダルからのインポート確定処理
  const handleConfirmScannedImport = async () => {
    if (!pendingZipImport) return;
    try {
      setImporting(true);
      setImportError(null);
      setImportSuccess(null);

      const { fileName, scanResult, manifest, modrinthIndex, mcVersion, loader } = pendingZipImport;
      const scannedJarMods = [
        ...scanResult.server.map(m => ({
          fileName: m.fileName,
          modId: m.modId,
          name: m.name,
          loader: m.loader,
          side: 'server',
          isServerSide: true,
          isClientSide: true,
        })),
        ...scanResult.clientOnly.map(m => ({
          fileName: m.fileName,
          modId: m.modId,
          name: m.name,
          loader: m.loader,
          side: 'client_only',
          isServerSide: false,
          isClientSide: true,
        })),
        ...scanResult.unknown.map(m => {
          const choice = unknownChoices[m.fileName] || 'client'; // デフォルトはサーバー除外(client)
          return {
            fileName: m.fileName,
            modId: m.modId,
            name: m.name,
            loader: m.loader,
            side: 'unknown',
            isServerSide: choice === 'server' || choice === 'both',
            isClientSide: choice === 'client' || choice === 'both',
          };
        }),
      ];

      const res = await apiFetch('/api/presets/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName,
          manifest,
          modrinthIndex,
          mcVersion,
          loader,
          scannedJarMods,
        }),
      });

      // サンドボックス互換診断で検出された不足前提MOD（サーバー側・クライアント側）の確認と構成追加
      let autoResolvedCount = 0;
      if (res.preset?.id) {
        const missingDeps = [
          ...(scanResult.compatibility?.missingServerDeps || []),
          ...(scanResult.compatibility?.missingClientDeps || []),
        ];
        const missingIds = Array.from(new Set(missingDeps.map(d => d.requiredModId)));
        let shouldAddMissing = true;
        if (missingIds.length > 0) {
          const detailLines = missingDeps
            .map(d => `・${d.requiredModId} (${d.targetSide === 'client' ? 'クライアント側で必須' : 'サーバー・共通で必須'} / 要求元: ${d.requiredByModName})`)
            .join('\n');
          shouldAddMissing = confirm(
            `⚠️ 【注意】サーバー側またはクライアント側にZIPファイルだけでは足りないMODが ${missingIds.length} 件検出されました。\n\n` +
            `${detailLines}\n\n` +
            `このMODが足りないため、構成に入れてもかまいませんか？`
          );
        }
        if (shouldAddMissing) {
          try {
            const resolveRes = await apiFetch(`/api/presets/${res.preset.id}/resolve-missing`, {
              method: 'POST',
              body: JSON.stringify({ missingModIds: missingIds }),
            });
            autoResolvedCount = resolveRes.resolvedMods?.length || 0;
          } catch (resolveErr) {
            console.warn('Auto resolve-missing failed during import:', resolveErr);
          }
        }
      }

      const serverCount = res.server_mods?.length ?? scannedJarMods.filter(m => m.isServerSide).length;
      const excludedCount = scannedJarMods.filter(m => !m.isServerSide).length;
      setPendingZipImport(null);
      setImportSuccess(
        `MODパック「${res.preset?.name || 'インポートパック'}」をインポートしました！（サーバー対象MOD: ${serverCount}個 / クライアント専用除外: ${excludedCount}個${autoResolvedCount > 0 ? ` / 前提MOD・URL自動補完: ${autoResolvedCount}件` : ''}）`
      );
      setTimeout(() => setImportSuccess(null), 6000);
      await fetchPresets();
    } catch (err: any) {
      console.error(err);
      setImportError(`インポート失敗: ${err.message || '不明なエラーが発生しました'}`);
    } finally {
      setImporting(false);
    }
  };

  // ZIP アップロード・インポート処理
  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;

    if (!file.name.endsWith('.zip')) {
      setImportError('ZIPファイル（.zip）のみインポート可能です。');
      return;
    }

    // 1GB上限チェック（ローカル環境用に緩和）
    if (file.size > 1024 * 1024 * 1024) {
      setImportError('ファイルサイズが1GBの上限を超えています。');
      return;
    }

    try {
      setImporting(true);
      setImportError(null);
      setImportSuccess(null);

      // Step 1: クライアント側で ZIP を展開して mods/*.jar の Side スキャンおよび manifest 抽出を実施
      let arrBuffer: ArrayBuffer | null = null;
      try {
        arrBuffer = await file.arrayBuffer();
      } catch (readErr) {
        arrBuffer = null;
      }

      if (arrBuffer) {
        const scanResult = await scanAndFilterMods(arrBuffer, (p) => setImportProgress(p));
        if (scanResult.all.length > 0) {
          let manifest: any = null;
          let modrinthIndex: any = null;
          let detectedMcVersion = '1.20.1';
          let detectedLoader = scanResult.all.find(m => m.loader !== 'unknown')?.loader || 'fabric';

          try {
            const zip = await JSZip.loadAsync(arrBuffer);
            const manifestFile = zip.file('manifest.json');
            const modrinthFile = zip.file('modrinth.index.json');
            if (manifestFile) {
              manifest = JSON.parse(await manifestFile.async('text'));
              detectedMcVersion = manifest.minecraft?.version || detectedMcVersion;
              const lid = manifest.minecraft?.modLoaders?.[0]?.id || '';
              if (lid.includes('neoforge')) detectedLoader = 'neoforge';
              else if (lid.includes('forge')) detectedLoader = 'forge';
              else if (lid.includes('quilt')) detectedLoader = 'quilt';
              else if (lid.includes('fabric')) detectedLoader = 'fabric';
            } else if (modrinthFile) {
              modrinthIndex = JSON.parse(await modrinthFile.async('text'));
              detectedMcVersion = modrinthIndex.game || detectedMcVersion;
              detectedLoader = modrinthIndex.loader || detectedLoader;
            }
          } catch (_) {
            // ignore manifest parse error if jars were scanned
          }

          // unknown の MOD はデフォルトで除外 ('client') に初期設定
          const initialUnknowns: Record<string, UnknownToggleChoice> = {};
          for (const u of scanResult.unknown) {
            initialUnknowns[u.fileName] = 'client';
          }
          setUnknownChoices(initialUnknowns);
          setPendingZipImport({
            fileName: file.name,
            scanResult,
            manifest,
            modrinthIndex,
            mcVersion: detectedMcVersion,
            loader: detectedLoader,
          });
          setImportProgress(null);
          setImporting(false);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
          return;
        }
      }

      const electronAPI = (window as any).electronAPI;
      const filePath = (file as any).path; // Electron固有: ローカルファイルパス
      let res;

      if (electronAPI?.importModpack && filePath) {
        // Electron環境：メインプロセス側で直接ファイル読込・HTTPアップロードを行う
        console.log('[Presets] Performing direct main process import:', filePath);
        const result = await electronAPI.importModpack(filePath, file.name);
        if (!result.success) {
          const errStr = String(result.error);
          let detailGuidance = '';

          if (errStr.includes('SQLITE_ERROR') || errStr.includes('too many SQL variables') || errStr.includes('D1_ERROR')) {
            detailGuidance = 
              `【想定される原因】:\n` +
              `MODパック内のMOD総数が非常に多く、ローカルデータベース（SQLite/D1）のバインド変数上限を超過しました。`;
          } else if (errStr.includes('ENOENT') || errStr.includes('Permission denied') || errStr.includes('EBUSY') || errStr.includes('Access denied') || errStr.includes('0x5')) {
            detailGuidance =
              `【想定される原因】:\n` +
              `ファイルの実体がローカルディスクに存在しない（OneDrive等のオンライン専用状態）、または他アプリによってロックされている可能性があります。`;
          } else {
            detailGuidance =
              `【想定される原因と対策】:\n` +
              `1. インポートしたZIPファイルが破損しているか、対応していない形式（manifest.json / modrinth.index.json / mods/*.jar がない）の可能性があります。\n` +
              `2. 接続先APIサーバーが一時的にオフラインになっている可能性があります。`;
          }

          throw new Error(
            `インポートに失敗しました。\n\n` +
            `【エラー詳細】:\n${result.error}\n\n` +
            `${detailGuidance}`
          );
        }
        res = result.data;
      } else {
        // ブラウザ環境：標準の arrayBuffer() で読み込んで POST 送信
        console.log('[Presets] Web browser environment. Reading file via standard Web API...');
        const fileData = arrBuffer ? new Uint8Array(arrBuffer) : new Uint8Array(await file.arrayBuffer());

        console.log('[Presets] Uploading zip pack as raw binary...');
        res = await apiFetch('/api/presets/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: fileData as any,
        });
      }

      setImportSuccess(
        `MODパック「${res.preset?.name || 'インポートパック'}」を正常にインポートしました！ (収録MOD数: ${res.mods?.length || 0}個)`
      );
      
      // 5秒後に成功通知を自動消去
      setTimeout(() => setImportSuccess(null), 5000);

      // リストを再読み込み
      await fetchPresets();
    } catch (err: any) {
      console.error(err);
      setImportError(`インポート失敗: ${err.message || '不明なエラーが発生しました'}`);
    } finally {
      setImportProgress(null);
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = ''; // ファイル選択をクリア
      }
    }
  };

  // ドラッグ＆ドロップイベント
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    handleImportFile(file);
  };

  const handleAreaClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    handleImportFile(file);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <h2>プリセット一覧</h2>
          <p style={{ color: '#9ca3af', marginTop: '0.6rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
            構成済みのMODパックやサーバー設定を管理します。
          </p>
        </div>
        <Button variant="primary" href="/dashboard/presets/new">
          ＋ 新規作成
        </Button>
      </div>

      {/* 🟢 プレミアムな ZIP アップロード / ドラッグ＆ドロップエリア */}
      <div style={{ marginBottom: '2.5rem' }}>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          accept=".zip" 
          style={{ display: 'none' }} 
        />
        <div 
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleAreaClick}
          style={{
            background: isDragging ? 'rgba(163, 217, 93, 0.06)' : 'rgba(18, 20, 26, 0.35)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: isDragging ? '2px dashed #a3d95d' : '2px dashed rgba(255, 255, 255, 0.12)',
            boxShadow: isDragging ? '0 0 25px rgba(163, 217, 93, 0.2), inset 0 0 12px rgba(255,255,255,0.03)' : 'inset 0 0 12px rgba(255,255,255,0.02)',
            borderRadius: '12px',
            padding: '2.5rem 2rem',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {importing ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.2rem' }}>
              <div className="pixel-spinner" style={{
                width: '40px',
                height: '40px',
                border: '4px solid rgba(163, 217, 93, 0.15)',
                borderTop: '4px solid #a3d95d',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }} />
              <style>{`
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              `}</style>
              <h4 style={{ color: '#a3d95d', fontSize: '1.1rem', fontWeight: 'bold' }}>
                {importProgress
                  ? `MODを分割読み込み中... (${importProgress.current} / ${importProgress.total} 件 - ${importProgress.percent}%)`
                  : 'MODパックのインポート中...'}
              </h4>
              <div style={{ color: '#9ca3af', fontSize: '0.88rem', fontFamily: 'Inter, sans-serif', maxWidth: '480px', lineHeight: '1.6', width: '100%' }}>
                {importProgress ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ color: '#bae6fd', fontSize: '0.82rem', wordBreak: 'break-all' }}>
                      現在解析中: {importProgress.currentFile}
                    </span>
                    <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ width: `${importProgress.percent}%`, height: '100%', background: '#38bdf8', transition: 'width 0.2s ease' }} />
                    </div>
                  </div>
                ) : (
                  'ZIPを解析し、前提MOD（依存関係）を CurseForge / Modrinth API からオンラインで自動解決して D1 データベースにキャッシュしています。しばらくお待ちください...'
                )}
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: '2.5rem', marginBottom: '1rem', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))' }}>📦</div>
              <h4 style={{ fontSize: '1.15rem', color: '#ffffff', marginBottom: '0.5rem', fontWeight: '700' }}>
                MODパック (ZIP) のインポート
              </h4>
              <p style={{ color: '#9ca3af', fontSize: '0.88rem', fontFamily: 'Inter, sans-serif', maxWidth: '520px', lineHeight: '1.6' }}>
                <span style={{ color: '#a3d95d', fontWeight: '600' }}>CurseForge 形式</span> または <span style={{ color: '#22d3ee', fontWeight: '600' }}>Modrinth 形式</span> の ZIPファイルをここにドラッグ＆ドロップ、またはクリックして選択してインポートします。
              </p>
            </>
          )}
        </div>

        {/* 🟢 エラー＆成功フィードバック表示 */}
        {importError && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: '8px',
            padding: '1rem 1.5rem',
            marginTop: '1.2rem',
            color: '#f87171',
            fontSize: '0.9rem',
            fontFamily: 'Inter, sans-serif',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.8rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
          }}>
            <span style={{ flexShrink: 0, marginTop: '2px' }}>⚠️</span>
            <span style={{ whiteSpace: 'pre-line', lineHeight: '1.6' }}>{importError}</span>
          </div>
        )}

        {importSuccess && (
          <div style={{
            background: 'rgba(163, 217, 93, 0.12)',
            border: '1px solid rgba(163, 217, 93, 0.25)',
            borderRadius: '8px',
            padding: '1rem 1.5rem',
            marginTop: '1.2rem',
            color: '#a3d95d',
            fontSize: '0.9rem',
            fontFamily: 'Inter, sans-serif',
            display: 'flex',
            alignItems: 'center',
            gap: '0.8rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
          }}>
            <span>✅</span>
            <span>{importSuccess}</span>
          </div>
        )}
      </div>

      {loading && (
        <p style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem', fontFamily: 'Inter, sans-serif' }}>
          読み込み中...
        </p>
      )}

      {!loading && error && (
        <GlassCard variant="stone" style={{ padding: '2rem', textAlign: 'center', marginBottom: '2rem' }}>
          <p style={{ color: '#ef4444', marginBottom: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'bold' }}>{error}</p>
          <Button variant="secondary" onClick={fetchPresets}>再試行</Button>
        </GlassCard>
      )}

      {!loading && !error && presets.length === 0 && (
        <GlassCard variant="stone" style={{ padding: '3rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
          <p style={{ color: '#9ca3af', fontFamily: 'Inter, sans-serif', fontSize: '1.1rem' }}>
            登録されているプリセットがありません。
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button variant="primary" onClick={handleCreateDemoPreset}>
              デモプリセットを作成する
            </Button>
            <Button variant="secondary" href="/dashboard/presets/new">
              自分で作成する
            </Button>
          </div>
        </GlassCard>
      )}

      {!loading && !error && presets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {presets.map((preset) => (
            <GlassCard 
              key={preset.id} 
              variant="stone" 
              interactive 
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1.25rem',
                padding: '1.5rem 1.75rem',
              }}
            >
              <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                <h3 style={{
                  fontSize: '1.25rem',
                  marginBottom: '0.75rem',
                  color: '#ffffff',
                  fontWeight: 'bold',
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.4,
                }}>
                  {preset.name}
                </h3>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  rowGap: '0.5rem',
                  columnGap: '1.25rem',
                  alignItems: 'center',
                  color: '#9ca3af',
                  fontSize: '0.92rem',
                  fontFamily: 'Inter, sans-serif',
                  fontWeight: '500',
                }}>
                  <span style={{ whiteSpace: 'nowrap' }}>🎮 Minecraft {preset.mc_version}</span>
                  <span style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>⚙️ {preset.loader}</span>
                  <span style={{ whiteSpace: 'nowrap' }}>⚡ 負荷スコア: {preset.estimated_load} ({preset.resource_profile === 'performance' ? '高性能' : '標準'})</span>
                  {preset.source && (
                    <span style={{ 
                      fontSize: '0.78rem', 
                      background: preset.source.includes('curseforge') ? 'rgba(239, 104, 38, 0.15)' : 'rgba(34, 211, 238, 0.15)',
                      color: preset.source.includes('curseforge') ? '#ef6826' : '#22d3ee',
                      padding: '0.12rem 0.5rem',
                      borderRadius: '4px',
                      textTransform: 'uppercase',
                      fontWeight: '700',
                      whiteSpace: 'nowrap',
                    }}>
                      📦 {preset.source.replace('_import', '')}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <Button 
                  variant="secondary" 
                  onClick={() => {
                    setEditingPreset(preset);
                    setNewPresetName(preset.name);
                  }}
                >
                  編集
                </Button>
                <Button 
                  variant="secondary" 
                  onClick={() => handleOpenModManager(preset)}
                >
                  MOD管理
                </Button>
                <Button 
                  variant="primary" 
                  onClick={() => handleLaunch(preset.id)}
                  disabled={launchingId !== null}
                >
                  {launchingId === preset.id ? '起動中...' : 'サーバー起動'}
                </Button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {/* 編集・削除モーダルダイアログ */}
      {editingPreset && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '1.5rem'
        }}>
          <GlassCard variant="stone" style={{ width: '100%', maxWidth: '450px', padding: '2.5rem' }}>
            <h3 style={{ fontSize: '1.25rem', color: '#ffffff', marginBottom: '1.5rem', fontWeight: 'bold' }}>
              プリセットの編集
            </h3>
            
            <div style={{ marginBottom: '2rem' }}>
              <label style={{ display: 'block', color: '#9ca3af', fontSize: '0.88rem', marginBottom: '0.6rem', fontFamily: 'Inter, sans-serif' }}>
                プリセット名
              </label>
              <input 
                type="text"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                style={{
                  width: '100%',
                  backgroundColor: 'rgba(0, 0, 0, 0.4)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  padding: '0.75rem 1rem',
                  fontSize: '1rem',
                  fontFamily: 'Inter, sans-serif'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <Button 
                variant="secondary" 
                style={{ 
                  color: '#ffffff', 
                  backgroundColor: 'rgba(239, 68, 68, 0.2)', 
                  borderColor: '#ef4444',
                  textShadow: 'none'
                }}
                disabled={updating}
                onClick={async () => {
                  if (!confirm(`本当にプリセット「${editingPreset.name}」を削除しますか？\n※関連する起動履歴データも一緒に削除されます。この操作は取り消せません。`)) {
                    return;
                  }
                  try {
                    setUpdating(true);
                    const res = await apiFetch(`/api/presets/${editingPreset.id}`, {
                      method: 'DELETE'
                    });
                    if (res.error) {
                      alert(`削除エラー: ${res.error}`);
                    } else {
                      setEditingPreset(null);
                      await fetchPresets();
                    }
                  } catch (err: any) {
                    alert(`削除エラー: ${err.message}`);
                  } finally {
                    setUpdating(false);
                  }
                }}
              >
                削除
              </Button>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Button 
                  variant="secondary" 
                  onClick={() => setEditingPreset(null)}
                  disabled={updating}
                >
                  キャンセル
                </Button>
                <Button 
                  variant="primary"
                  disabled={updating || !newPresetName.trim()}
                  onClick={async () => {
                    try {
                      setUpdating(true);
                      const res = await apiFetch(`/api/presets/${editingPreset.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ name: newPresetName })
                      });
                      if (res.error) {
                        alert(`更新エラー: ${res.error}`);
                      } else {
                        setEditingPreset(null);
                        await fetchPresets();
                      }
                    } catch (err: any) {
                      alert(`更新エラー: ${err.message}`);
                    } finally {
                      setUpdating(false);
                    }
                  }}
                >
                  {updating ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* 📦 MOD管理モーダルダイアログ */}
      {managingPreset && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '1.5rem'
        }}>
          <GlassCard variant="stone" style={{ width: '100%', maxWidth: '720px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: '2.5rem', overflow: 'hidden' }}>
            {/* ヘッダー */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1rem' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{ fontSize: '1.3rem', color: '#ffffff', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.6rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                  <span>📦</span> {managingPreset.name} のMOD管理
                </h3>
                <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginTop: '0.4rem', fontFamily: 'Inter, sans-serif' }}>
                  🎮 Minecraft {managingPreset.mc_version} | ⚙️ <span style={{ textTransform: 'capitalize' }}>{managingPreset.loader}</span>
                </p>
              </div>
              <button 
                onClick={() => setManagingPreset(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#9ca3af',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  padding: '0.2rem',
                  lineHeight: '1',
                  transition: 'color 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#ffffff'}
                onMouseLeave={(e) => e.currentTarget.style.color = '#9ca3af'}
              >
                ×
              </button>
            </div>

            {/* タブ切り替え */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.75rem' }}>
              <button
                onClick={() => setModActiveTab('list')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: modActiveTab === 'list' ? '#a3d95d' : '#9ca3af',
                  borderBottom: modActiveTab === 'list' ? '2px solid #a3d95d' : 'none',
                  padding: '0.5rem 1rem',
                  fontWeight: '600',
                  fontSize: '0.95rem',
                  cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  transition: 'all 0.2s'
                }}
              >
                導入済みMOD ({presetMods.length})
              </button>
              <button
                onClick={() => setModActiveTab('search')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: modActiveTab === 'search' ? '#a3d95d' : '#9ca3af',
                  borderBottom: modActiveTab === 'search' ? '2px solid #a3d95d' : 'none',
                  padding: '0.5rem 1rem',
                  fontWeight: '600',
                  fontSize: '0.95rem',
                  cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  transition: 'all 0.2s'
                }}
              >
                🔍 新しいMODを追加
              </button>
            </div>

            {/* コンテンツエリア (スクロール可能) */}
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1.5rem', paddingRight: '0.5rem' }}>
              {loadingMods ? (
                <p style={{ color: '#9ca3af', textAlign: 'center', padding: '3rem', fontFamily: 'Inter, sans-serif' }}>
                  MOD情報を読み込み中...
                </p>
              ) : modActiveTab === 'list' ? (
                /* === 導入済みMODリスト === */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  {/* 手動追加MOD */}
                  <div>
                    <h4 style={{ color: '#ffffff', fontSize: '0.95rem', marginBottom: '0.8rem', fontWeight: 'bold', borderLeft: '3px solid #a3d95d', paddingLeft: '0.5rem' }}>
                      手動追加したMOD (ユーザー指定)
                    </h4>
                    {presetMods.filter(m => m.manually_added === 1).length === 0 ? (
                      <p style={{ color: '#6b7280', fontSize: '0.85rem', fontStyle: 'italic', paddingLeft: '0.8rem' }}>手動追加されたMODはありません。</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                        {presetMods.filter(m => m.manually_added === 1).map((mod) => (
                          <div key={mod.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', minWidth: 0, flex: '1 1 200px' }}>
                              <span style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.95rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{mod.name}</span>
                              <span style={{ fontSize: '0.75rem', color: '#9ca3af', background: 'rgba(255,255,255,0.08)', padding: '0.1rem 0.4rem', borderRadius: '4px', textTransform: 'uppercase' }}>
                                {mod.source}
                              </span>
                              <span style={{
                                fontSize: '0.72rem',
                                background: mod.is_server_side === 0 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                color: mod.is_server_side === 0 ? '#fbbf24' : '#34d399',
                                padding: '0.1rem 0.45rem',
                                borderRadius: '4px',
                                fontWeight: '600',
                              }}>
                                {mod.is_server_side === 0 ? '🚫 クライアント専用 (サーバー除外)' : '✅ サーバー追加対象'}
                              </span>
                            </div>
                            <Button 
                              variant="secondary"
                              disabled={updatingMods}
                              style={{ 
                                padding: '0.35rem 0.75rem', 
                                fontSize: '0.8rem', 
                                backgroundColor: 'rgba(239, 68, 68, 0.12)', 
                                borderColor: 'rgba(239, 68, 68, 0.3)', 
                                color: '#f87171' 
                              }}
                              onClick={() => handleDeleteMod(mod.id)}
                            >
                              🗑️ 削除
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 自動追加MOD */}
                  <div>
                    <h4 style={{ color: '#ffffff', fontSize: '0.95rem', marginBottom: '0.8rem', fontWeight: 'bold', borderLeft: '3px solid #22d3ee', paddingLeft: '0.5rem' }}>
                      自動追加されたMOD (前提関係・軽量化パック)
                    </h4>
                    {presetMods.filter(m => m.manually_added === 0).length === 0 ? (
                      <p style={{ color: '#6b7280', fontSize: '0.85rem', fontStyle: 'italic', paddingLeft: '0.8rem' }}>自動追加されたMODはありません。</p>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.6rem' }}>
                        {presetMods.filter(m => m.manually_added === 0).map((mod) => (
                          <div key={mod.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)', padding: '0.6rem 0.88rem', borderRadius: '6px', minWidth: 0 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0 }}>
                              <span style={{ color: '#e5e7eb', fontWeight: '500', fontSize: '0.88rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{mod.name}</span>
                              <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                                {mod.is_lightweight_pack === 1 ? '⚡ 軽量化パック自動注入' : '🔗 前提MOD自動解決'} ({mod.is_server_side === 0 ? 'クライアント専用' : 'サーバー対応'})
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* === MOD検索追加エリア === */
                <div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                    <input 
                      type="text"
                      placeholder="MOD名を入力してください (例: sodium, jei, xaeros)"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSearchMods(); }}
                      style={{
                        flex: '1 1 200px',
                        minWidth: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.4)',
                        color: '#ffffff',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        borderRadius: '6px',
                        padding: '0.6rem 1rem',
                        fontSize: '0.95rem',
                        fontFamily: 'Inter, sans-serif'
                      }}
                    />
                    <Button 
                      variant="primary"
                      disabled={searching || !searchQuery.trim()}
                      onClick={handleSearchMods}
                      style={{ padding: '0.6rem 1.25rem' }}
                    >
                      {searching ? '検索中...' : '検索'}
                    </Button>
                  </div>

                  {/* 検索結果 */}
                  {searching ? (
                    <p style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem', fontFamily: 'Inter, sans-serif' }}>
                      Modrinth / CurseForge を検索中...
                    </p>
                  ) : searchResults.length === 0 ? (
                    searchQuery ? (
                      <p style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem', fontFamily: 'Inter, sans-serif', fontSize: '0.9rem' }}>
                        一致するMODが見つかりませんでした。(検索条件: Minecraft {managingPreset.mc_version}, {managingPreset.loader})
                      </p>
                    ) : (
                      <p style={{ color: '#6b7280', textAlign: 'center', padding: '3rem', fontFamily: 'Inter, sans-serif', fontSize: '0.9rem', fontStyle: 'italic' }}>
                        キーワードを入力してMODを探しましょう。対応するマイクラバージョンとローダーで検索されます。
                      </p>
                    )
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      {searchResults.map((mod) => (
                        <div key={mod.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.8rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', padding: '1rem', borderRadius: '8px' }}>
                          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                              <h5 style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '0.98rem' }}>{mod.title}</h5>
                              <span style={{ fontSize: '0.72rem', background: mod.source === 'curseforge' ? 'rgba(239, 104, 38, 0.15)' : 'rgba(163, 217, 93, 0.15)', color: mod.source === 'curseforge' ? '#ef6826' : '#a3d95d', padding: '0.08rem 0.35rem', borderRadius: '4px', textTransform: 'uppercase', fontWeight: '700' }}>
                                {mod.source || 'modrinth'}
                              </span>
                              <span style={{
                                fontSize: '0.72rem',
                                background: mod.server_side === 'unsupported' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                color: mod.server_side === 'unsupported' ? '#fbbf24' : '#34d399',
                                padding: '0.08rem 0.45rem',
                                borderRadius: '4px',
                                fontWeight: '600',
                              }}>
                                {mod.server_side === 'unsupported' ? '💻 クライアント専用 (サーバー除外)' : '🖥️ サーバー対応'}
                              </span>
                            </div>
                            <p style={{ color: '#9ca3af', fontSize: '0.82rem', fontFamily: 'Inter, sans-serif', lineHeight: '1.4' }}>
                              {mod.description || '説明はありません。'}
                            </p>
                          </div>
                          <Button 
                            variant="primary"
                            disabled={updatingMods}
                            onClick={() => handleAddMod(mod)}
                            style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
                          >
                            ＋ 追加
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* フッター */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1rem', gap: '0.8rem', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onClick={() => handleResolveMissingForPreset(managingPreset.id)}
                disabled={updatingMods}
                style={{
                  borderColor: 'rgba(56, 189, 248, 0.45)',
                  backgroundColor: 'rgba(56, 189, 248, 0.12)',
                  color: '#38bdf8',
                  fontSize: '0.85rem',
                  whiteSpace: 'normal',
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}
              >
                {updatingMods ? '🔄 検索・補完中...' : '🔍 不足している前提MOD・DLリンクを自動検索・補完'}
              </Button>
              <Button 
                variant="secondary" 
                onClick={() => setManagingPreset(null)}
                disabled={updatingMods}
              >
                閉じる
              </Button>
            </div>
          </GlassCard>
        </div>
      )}

      {/* 🛡️ MOD Side 判定・仕分け確認モーダル (Step 3: UI確認画面) */}
      {pendingZipImport && (
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
          <GlassCard variant="stone" style={{ width: '100%', maxWidth: '820px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: '2.2rem', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '1rem', marginBottom: '1.2rem' }}>
              <div>
                <h3 style={{ fontSize: '1.35rem', color: '#ffffff', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <span>🛡️</span> MOD Side 自動判定・仕分け確認
                </h3>
                <p style={{ color: '#9ca3af', fontSize: '0.88rem', marginTop: '0.4rem', fontFamily: 'Inter, sans-serif' }}>
                  ZIP内の <code>mods/*.jar</code> メタデータ（Fabric / Quilt / Forge / NeoForge）を解析しました。サーバー起動前にクライアント専用MODを自動除外します。
                </p>
              </div>
              <button
                onClick={() => setPendingZipImport(null)}
                style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {/* バージョン・ローダー確認バー */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '0.85rem 1.2rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
              <span style={{ color: '#e5e7eb', fontSize: '0.9rem', fontWeight: '600' }}>📁 {pendingZipImport.fileName}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>MCバージョン:</span>
                <select
                  value={pendingZipImport.mcVersion}
                  onChange={(e) => setPendingZipImport({ ...pendingZipImport, mcVersion: e.target.value })}
                  style={{ background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '4px', padding: '0.25rem 0.6rem' }}
                >
                  <option value="1.20.4">1.20.4</option>
                  <option value="1.20.1">1.20.1</option>
                  <option value="1.19.4">1.19.4</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>ローダー:</span>
                <select
                  value={pendingZipImport.loader}
                  onChange={(e) => setPendingZipImport({ ...pendingZipImport, loader: e.target.value })}
                  style={{ background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '4px', padding: '0.25rem 0.6rem' }}
                >
                  <option value="fabric">Fabric</option>
                  <option value="forge">Forge</option>
                  <option value="neoforge">NeoForge</option>
                  <option value="quilt">Quilt</option>
                </select>
              </div>
            </div>

            {/* 🧪 サンドボックス互換診断（サーバー起動 & クライアント入室テスト） */}
            {pendingZipImport.scanResult.compatibility && (
              <div style={{
                background: (pendingZipImport.scanResult.compatibility.isServerReady && pendingZipImport.scanResult.compatibility.isClientReady)
                  ? 'rgba(16, 185, 129, 0.08)'
                  : 'rgba(245, 158, 11, 0.1)',
                border: `1px solid ${(pendingZipImport.scanResult.compatibility.isServerReady && pendingZipImport.scanResult.compatibility.isClientReady) ? 'rgba(16, 185, 129, 0.35)' : 'rgba(245, 158, 11, 0.4)'}`,
                borderRadius: '8px',
                padding: '0.9rem 1.1rem',
                marginBottom: '1rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem', marginBottom: '0.45rem' }}>
                  <span style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '0.92rem' }}>
                    🧪 サンドボックス事前検証（サーバー起動 ＆ クライアント入室互換性）
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.55rem',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      background: pendingZipImport.scanResult.compatibility.isServerReady ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.25)',
                      color: pendingZipImport.scanResult.compatibility.isServerReady ? '#34d399' : '#fbbf24',
                    }}>
                      {pendingZipImport.scanResult.compatibility.isServerReady ? '🟢 サーバー前提MOD完備' : `⚠️ サーバー不足前提MOD: ${pendingZipImport.scanResult.compatibility.missingServerDeps.length}件`}
                    </span>
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.55rem',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      background: pendingZipImport.scanResult.compatibility.isClientReady ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.25)',
                      color: pendingZipImport.scanResult.compatibility.isClientReady ? '#34d399' : '#fbbf24',
                    }}>
                      {pendingZipImport.scanResult.compatibility.isClientReady ? '🟢 クライアント入室前提MOD完備' : `⚠️ クライアント不足前提MOD: ${pendingZipImport.scanResult.compatibility.missingClientDeps.length}件`}
                    </span>
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.55rem',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      background: 'rgba(56, 189, 248, 0.18)',
                      color: '#38bdf8',
                    }}>
                      💻 クライアント入室必要MOD: {pendingZipImport.scanResult.compatibility.requiredClientMods.length}件
                    </span>
                  </div>
                </div>
                {(pendingZipImport.scanResult.compatibility.missingServerDeps.length > 0 || pendingZipImport.scanResult.compatibility.missingClientDeps.length > 0) ? (
                  <div style={{ fontSize: '0.82rem', color: '#fde68a', lineHeight: '1.55', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(248, 113, 113, 0.45)', borderRadius: '6px', padding: '0.65rem 0.85rem' }}>
                    <div style={{ color: '#fca5a5', fontWeight: 'bold', marginBottom: '0.35rem' }}>
                      ⚠️ 【注意】サーバー側またはクライアント側にZIPファイルだけでは足りないMODが検出されました。以下のMODが足りないため、構成に入れてもかまいませんか？（承認して登録すると確認のうえ構成へ追加します）：
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.35rem' }}>
                      {[...pendingZipImport.scanResult.compatibility.missingServerDeps, ...pendingZipImport.scanResult.compatibility.missingClientDeps].map((dep, idx) => (
                        <span key={`${dep.requiredModId}-${idx}`} style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(245, 158, 11, 0.4)', padding: '0.15rem 0.5rem', borderRadius: '4px', color: '#fff' }}>
                          <strong>{dep.requiredModId}</strong> <span style={{ color: '#9ca3af' }}>(要求元: {dep.requiredByModName} / {dep.targetSide === 'client' ? 'クライアント側で必須' : 'サーバー・共通で必須'})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.8rem', color: '#a7f3d0' }}>
                    ZIP内の全MODについて、サーバー起動およびクライアントがサーバーに入室するための前提MOD依存関係がすべて満たされています。
                  </div>
                )}
              </div>
            )}

            {/* 3カテゴリ一覧 */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.4rem', paddingRight: '0.4rem' }}>
              {/* 1. サーバーに追加されるMOD */}
              <div>
                <h4 style={{ color: '#34d399', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>✅ サーバーに追加されるMOD ({pendingZipImport.scanResult.server.length}件)</span>
                </h4>
                {pendingZipImport.scanResult.server.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>該当するMODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    <ChunkedList
                      items={pendingZipImport.scanResult.server}
                      resetKey={pendingZipImport.fileName}
                      renderItem={(m) => (
                        <div key={m.fileName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '6px', padding: '0.6rem 0.9rem' }}>
                          <div>
                            <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name} <span style={{ color: '#9ca3af', fontSize: '0.8rem', fontWeight: 'normal' }}>({m.fileName})</span></div>
                            <div style={{ color: '#6ee7b7', fontSize: '0.78rem', marginTop: '0.15rem' }}>{m.explanation}</div>
                          </div>
                          <span style={{ fontSize: '0.75rem', background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 'bold', textTransform: 'uppercase' }}>{m.loader}</span>
                        </div>
                      )}
                    />
                  </div>
                )}
              </div>

              {/* 2. クライアント専用として除外されるMOD */}
              <div>
                <h4 style={{ color: '#f87171', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>🚫 クライアント専用としてサーバーから除外されるMOD ({pendingZipImport.scanResult.clientOnly.length}件)</span>
                </h4>
                {pendingZipImport.scanResult.clientOnly.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>クライアント専用として除外されたMODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    <ChunkedList
                      items={pendingZipImport.scanResult.clientOnly}
                      resetKey={pendingZipImport.fileName}
                      renderItem={(m) => (
                        <div key={m.fileName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '6px', padding: '0.6rem 0.9rem' }}>
                          <div>
                            <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name} <span style={{ color: '#9ca3af', fontSize: '0.8rem', fontWeight: 'normal' }}>({m.fileName})</span></div>
                            <div style={{ color: '#fca5a5', fontSize: '0.8rem', marginTop: '0.15rem' }}>除外理由: {m.explanation}</div>
                          </div>
                          <span style={{ fontSize: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>CLIENT ONLY</span>
                        </div>
                      )}
                    />
                  </div>
                )}
              </div>

              {/* 3. 判定不明のMOD（デフォルト除外・ユーザートグル選択） */}
              <div>
                <h4 style={{ color: '#fbbf24', fontSize: '0.98rem', fontWeight: 'bold', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>❓ 判定不明のMOD ({pendingZipImport.scanResult.unknown.length}件) — デフォルトでサーバー除外</span>
                </h4>
                <p style={{ color: '#9ca3af', fontSize: '0.82rem', marginBottom: '0.6rem' }}>
                  メタデータから自動判定できなかったMODです。安全のためデフォルトは <strong>client (サーバーから除外)</strong> になっています。サーバーへ導入する場合は <strong>server</strong> または <strong>both</strong> に切り替えてください。
                </p>
                {pendingZipImport.scanResult.unknown.length === 0 ? (
                  <p style={{ color: '#6b7280', fontSize: '0.85rem', paddingLeft: '0.8rem' }}>判定不明のMODはありません。</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <ChunkedList
                      items={pendingZipImport.scanResult.unknown}
                      resetKey={pendingZipImport.fileName}
                      renderItem={(m) => {
                        const currentChoice = unknownChoices[m.fileName] || 'client';
                        return (
                          <div key={m.fileName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', background: 'rgba(245, 158, 11, 0.07)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: '6px', padding: '0.65rem 0.9rem', flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: '220px' }}>
                              <div style={{ color: '#ffffff', fontWeight: '600', fontSize: '0.92rem' }}>{m.name} <span style={{ color: '#9ca3af', fontSize: '0.8rem', fontWeight: 'normal' }}>({m.fileName})</span></div>
                              <div style={{ color: '#fcd34d', fontSize: '0.78rem', marginTop: '0.15rem' }}>{m.explanation}</div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              {(['client', 'server', 'both'] as UnknownToggleChoice[]).map((opt) => {
                                const active = currentChoice === opt;
                                const label = opt === 'client' ? 'client (除外)' : opt === 'server' ? 'server (追加)' : 'both (両方)';
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => setUnknownChoices(prev => ({ ...prev, [m.fileName]: opt }))}
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.2rem', marginTop: '1.2rem' }}>
              <Button variant="secondary" onClick={() => setPendingZipImport(null)} disabled={importing}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={handleConfirmScannedImport} disabled={importing}>
                {importing ? 'インポート処理中...' : '承認してプリセットを登録'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}


