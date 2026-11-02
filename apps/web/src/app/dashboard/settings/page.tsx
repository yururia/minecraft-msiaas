'use client';

import React, { useEffect, useState } from 'react';
import { GlassCard } from '../../../components/GlassCard';
import { Button } from '../../../components/Button';
import { apiFetch } from '../../../lib/api';
import styles from './page.module.css';

interface TauriWindow {
  __TAURI__?: {
    invoke: <T = unknown>(cmd: string, args?: Record<string, any>) => Promise<T>;
  };
}

interface JavaInfo {
  available: boolean;
  version: string | null;
  path: string | null;
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [isSaved, setIsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 設定項目状態
  const [minecraftUuid, setMinecraftUuid] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [defaultMemoryGb, setDefaultMemoryGb] = useState(4);
  const [usePlayitGg, setUsePlayitGg] = useState(true);
  
  // game properties
  const [pvp, setPvp] = useState(true);
  const [difficulty, setDifficulty] = useState('easy');
  const [gamemode, setGamemode] = useState('survival');
  const [maxPlayers, setMaxPlayers] = useState(20);
  const [allowFlight, setAllowFlight] = useState(false);
  const [whiteList, setWhiteList] = useState(false);
  const [viewDistance, setViewDistance] = useState(6);
  const [motd, setMotd] = useState('MSIaaS Local Server');

  // システム物理メモリ上限 (Tauri用、デフォルト16)
  const [systemMemoryGb, setSystemMemoryGb] = useState(16);
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  // 設定のロード
  const loadSettings = async () => {
    try {
      setLoading(true);
      const res = await apiFetch('/api/settings');
      if (res.settings) {
        const s = res.settings;
        setMinecraftUuid(s.minecraftUuid || '');
        setJavaPath(s.javaPath || '');
        setDefaultMemoryGb(s.defaultMemoryGb || 4);
        setUsePlayitGg(s.usePlayitGg !== false);
        setPvp(s.pvp !== false);
        setDifficulty(s.difficulty || 'easy');
        setGamemode(s.gamemode || 'survival');
        setMaxPlayers(s.maxPlayers || 20);
        setAllowFlight(!!s.allowFlight);
        setWhiteList(!!s.whiteList);
        setViewDistance(s.viewDistance || 6);
        setMotd(s.motd || 'MSIaaS Local Server');
      }
    } catch (err: any) {
      console.error('Failed to load settings:', err);
      setSaveError('設定の読み込みに失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();

    // Tauri環境から物理メモリサイズを取得してスライダー上限値とする
    if (isTauri) {
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (tauri) {
        tauri.invoke<number>('get_system_memory')
          .then((mem) => {
            setSystemMemoryGb(mem);
          })
          .catch((err) => console.error('Failed to get system memory:', err));
      }
    }
  }, [isTauri]);

  // 設定の保存
  const handleSave = async () => {
    setSaveError(null);
    setIsSaved(false);
    try {
      const body = {
        minecraftUuid: minecraftUuid || null,
        javaPath: javaPath || null,
        defaultMemoryGb: Number(defaultMemoryGb),
        usePlayitGg,
        pvp,
        difficulty,
        gamemode,
        maxPlayers: Number(maxPlayers),
        allowFlight,
        whiteList,
        viewDistance: Number(viewDistance),
        motd,
      };

      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });

      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 3000);
    } catch (err: any) {
      console.error('Failed to save settings:', err);
      setSaveError(err.message || '設定の保存に失敗しました。');
    }
  };

  // Javaパスの自動検出 (Tauri用)
  const handleDetectJava = async () => {
    if (!isTauri) {
      alert('自動検出はデスクトップアプリ(Tauri)内でのみ利用可能です。');
      return;
    }
    try {
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (tauri) {
        const javaInfo = await tauri.invoke<JavaInfo>('check_java_available');
        if (javaInfo.available && javaInfo.path) {
          setJavaPath(javaInfo.path);
          alert(`Java環境を検出しました！\nバージョン: ${javaInfo.version}\nパス: ${javaInfo.path}`);
        } else {
          alert('システム上に適切なJavaが見つかりませんでした。手動でパスを設定してください。');
        }
      }
    } catch (err) {
      alert(`Java検出エラー: ${err}`);
    }
  };

  // サーバーデータ全初期化 (Tauri用)
  const handleResetData = async () => {
    if (!confirm(
      '【⚠️警告：ローカルサーバーデータの初期化】\n\n' +
      'PC内に構築されたすべてのMinecraftサーバーディレクトリ、ワールドセーブデータ、' +
      'およびダウンロード済みのMODファイルが完全に削除されます。\n' +
      'この操作は取り消せません！本当に初期化しますか？'
    )) {
      return;
    }

    if (!isTauri) {
      alert('データリセットはデスクトップアプリ(Tauri)内でのみ実行可能です。');
      return;
    }

    try {
      const tauri = (window as unknown as TauriWindow).__TAURI__;
      if (tauri) {
        const success = await tauri.invoke<boolean>('reset_all_server_data');
        if (success) {
          alert('すべてのサーバーデータとキャッシュを初期化しました。');
          setJavaPath('');
          setDefaultMemoryGb(4);
        } else {
          alert('一部のファイルの削除に失敗した可能性があります。サーバーが起動中でないか確認してください。');
        }
      }
    } catch (err) {
      alert(`初期化エラー: ${err}`);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh', color: '#ffffff', fontFamily: 'Inter, sans-serif' }}>
        <p>設定をロード中...</p>
      </div>
    );
  }

  // メモリ最大値のバリデーション (Windowsのハング防止のため物理メモリの70%に制限、最小値4GB)
  const maxAllocatableMemory = Math.max(4, Math.floor(systemMemoryGb * 0.7));

  return (
    <div className={styles.container}>
      <div style={{ marginBottom: '1rem' }}>
        <h2>サーバー・環境設定</h2>
        <p style={{ color: '#9ca3af', marginTop: '0.6rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
          ローカルの Java 動作環境および Minecraft サーバーの基本ルールを設定します。
        </p>
      </div>

      <GlassCard variant="stone" style={{ padding: '2.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
          
          <div className={styles.grid}>
            
            {/* Left Column: System & Launch Config */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>🖥️ システム & 起動設定</h3>
              
              <div className={styles.formGroup}>
                <label className={styles.label}>Minecraft アカウント UUID</label>
                <input 
                  type="text" 
                  className={styles.input} 
                  value={minecraftUuid} 
                  onChange={(e) => setMinecraftUuid(e.target.value)} 
                  placeholder="例: 069a79f4-44e9-4726-a5be-fca90e38aaf5" 
                />
                <p className={styles.desc}>
                  ホワイトリスト登録用のUUIDです。未入力時は起動時に自動ホワイトリスト処理がスキップされます。
                </p>
              </div>

              <div className={styles.formGroup} style={{ marginTop: '0.5rem' }}>
                <label className={styles.label}>Java実行パス (java.exe)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <input 
                    type="text" 
                    className={styles.input} 
                    style={{ flex: '1 1 200px', minWidth: 0 }}
                    value={javaPath} 
                    onChange={(e) => setJavaPath(e.target.value)} 
                    placeholder="未設定時は自動検出パスを使用" 
                  />
                  <Button variant="secondary" onClick={handleDetectJava} style={{ padding: '0.6rem 1rem', fontSize: '0.85rem' }}>
                    自動検出
                  </Button>
                </div>
                <p className={styles.desc}>
                  特定のバージョンの Java を使用したい場合は、その実行可能ファイルのフルパスを指定してください。
                </p>
              </div>

              <div className={styles.formGroup} style={{ marginTop: '0.5rem' }}>
                <label className={styles.label}>デフォルト割り当てメモリ (2GB刻み)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                  <input 
                    type="range" 
                    min="4" 
                    max={maxAllocatableMemory} 
                    step="2"
                    value={defaultMemoryGb} 
                    onChange={(e) => setDefaultMemoryGb(Number(e.target.value))}
                    style={{ flex: 1, accentColor: '#a3d95d' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input 
                      type="number"
                      min="4"
                      max={maxAllocatableMemory}
                      step="2"
                      value={defaultMemoryGb}
                      onChange={(e) => {
                        let val = Number(e.target.value);
                        if (val > maxAllocatableMemory) val = maxAllocatableMemory;
                        if (val < 4) val = 4;
                        setDefaultMemoryGb(val);
                      }}
                      style={{ 
                        width: '4.5rem', 
                        textAlign: 'center', 
                        fontFamily: 'VT323, monospace', 
                        fontSize: '1.25rem', 
                        padding: '0.25rem',
                        backgroundColor: 'rgba(0, 0, 0, 0.4)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '4px',
                        color: '#ffffff'
                      }}
                    />
                    <span style={{ color: '#9ca3af', fontSize: '1rem', fontFamily: 'VT323, monospace' }}>GB</span>
                  </div>
                </div>
                <p className={styles.desc}>
                  サーバー起動時に割り当てるメモリの上限です（ホストメモリの 70% までに自動制限されます）。
                </p>
              </div>

              <div className={styles.formGroup} style={{ marginTop: '0.5rem' }}>
                <label className={styles.label}>外部接続トンネルプロバイダー</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem 1.5rem', marginTop: '0.25rem' }}>
                  <label className={styles.switchLabel}>
                    <input 
                      type="radio" 
                      name="tunnel"
                      checked={usePlayitGg} 
                      onChange={() => setUsePlayitGg(true)}
                    />
                    playit.gg (推奨・カスタムドメイン対応)
                  </label>
                  <label className={styles.switchLabel}>
                    <input 
                      type="radio" 
                      name="tunnel"
                      checked={!usePlayitGg} 
                      onChange={() => setUsePlayitGg(false)}
                    />
                    Serveo.net (SSHトンネル)
                  </label>
                </div>
              </div>

            </div>

            {/* Right Column: game properties settings */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>🎮 ゲーム内ルール設定 (properties)</h3>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>難易度 (Difficulty)</label>
                  <select 
                    className={styles.input} 
                    value={difficulty} 
                    onChange={(e) => setDifficulty(e.target.value)}
                  >
                    <option value="peaceful">Peaceful</option>
                    <option value="easy">Easy</option>
                    <option value="normal">Normal</option>
                    <option value="hard">Hard</option>
                  </select>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>ゲームモード (Game Mode)</label>
                  <select 
                    className={styles.input} 
                    value={gamemode} 
                    onChange={(e) => setGamemode(e.target.value)}
                  >
                    <option value="survival">Survival</option>
                    <option value="creative">Creative</option>
                    <option value="adventure">Adventure</option>
                    <option value="spectator">Spectator</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginTop: '0.25rem' }}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>最大プレイヤー数</label>
                  <input 
                    type="number" 
                    className={styles.input}
                    min="1" 
                    max="100"
                    value={maxPlayers} 
                    onChange={(e) => setMaxPlayers(Number(e.target.value))}
                  />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>描画距離 (View Distance)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
                    <input 
                      type="range" 
                      min="4" 
                      max="16" 
                      value={viewDistance} 
                      onChange={(e) => setViewDistance(Number(e.target.value))}
                      style={{ flex: 1, accentColor: '#a3d95d' }}
                    />
                    <span style={{ color: '#ffffff', fontFamily: 'VT323, monospace', fontSize: '1.15rem' }}>
                      {viewDistance}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', marginTop: '0.75rem' }}>
                <label className={styles.switchLabel}>
                  <input 
                    type="checkbox" 
                    className={styles.checkbox}
                    checked={pvp} 
                    onChange={(e) => setPvp(e.target.checked)} 
                  />
                  PVP (フレンドリーファイア) を許可する
                </label>

                <label className={styles.switchLabel}>
                  <input 
                    type="checkbox" 
                    className={styles.checkbox}
                    checked={allowFlight} 
                    onChange={(e) => setAllowFlight(e.target.checked)} 
                  />
                  飛行を許可する (allow-flight)
                </label>

                <label className={styles.switchLabel}>
                  <input 
                    type="checkbox" 
                    className={styles.checkbox}
                    checked={whiteList} 
                    onChange={(e) => setWhiteList(e.target.checked)} 
                  />
                  ホワイトリストを適用する
                </label>
              </div>

              <div className={styles.formGroup} style={{ marginTop: '0.75rem', maxWidth: '100%' }}>
                <label className={styles.label}>サーバー説明文 (MOTD)</label>
                <input 
                  type="text" 
                  className={styles.input} 
                  value={motd} 
                  onChange={(e) => setMotd(e.target.value)} 
                  placeholder="サーバー一覧に表示される文面" 
                />
              </div>

            </div>

          </div>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '2rem' }}>
            <Button variant="primary" onClick={handleSave} style={{ minWidth: '150px' }}>設定を保存</Button>
            {isSaved && (
              <span style={{ color: '#a3d95d', fontFamily: 'DotGothic16', fontWeight: 'bold' }}>
                ✔ 設定を保存しました！
              </span>
            )}
            {saveError && (
              <span style={{ color: '#ef4444', fontFamily: 'Inter', fontWeight: 'bold', fontSize: '0.9rem' }}>
                ❌ {saveError}
              </span>
            )}
          </div>

          {/* Danger Zone */}
          <div className={styles.section} style={{ borderTop: '4px dashed rgba(239, 68, 68, 0.15)', paddingTop: '2rem' }}>
            <h3 className={styles.sectionTitle} style={{ color: '#ef4444', borderBottomColor: 'rgba(239, 68, 68, 0.2)' }}>⚠️ 危険エリア</h3>
            <div style={{ maxWidth: '700px' }}>
              <p className={styles.desc} style={{ color: '#fca5a5', fontWeight: '600', marginBottom: '0.6rem' }}>
                ローカルサーバーデータおよびキャッシュの完全初期化
              </p>
              <p className={styles.desc} style={{ marginBottom: '1.25rem' }}>
                PC内にダウンロードして蓄積された Minecraft サーバー実行用JAR、各種MODファイル、ワールドデータ（セーブ）を完全に一括削除します。ディスク空き容量を確保したい場合や、環境が壊れて最初からやり直したい場合に実行してください。
              </p>
              <Button variant="secondary" onClick={handleResetData} style={{ 
                color: '#ffffff', 
                backgroundColor: 'rgba(239, 68, 68, 0.15)', 
                borderColor: '#ef4444',
                textShadow: 'none',
                whiteSpace: 'normal',
                textAlign: 'center',
                lineHeight: 1.4,
              }}>
                サーバーデータとキャッシュを完全に初期化する
              </Button>
            </div>
          </div>

        </div>
      </GlassCard>
    </div>
  );
}
