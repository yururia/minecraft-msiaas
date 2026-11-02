'use client';

import React, { useState } from 'react';
import { GlassCard } from '../../../../components/GlassCard';
import { Button } from '../../../../components/Button';
import { apiFetch } from '../../../../lib/api';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';

interface ModItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  versions: string[];
  client_side: string;
  server_side: string;
  download_url?: string;
  source?: 'curseforge' | 'modrinth';
}

// ==========================================
// 日本語・英語検索変換エンジン (ローマ字/仮名マッピング)
// ==========================================
const convertKanaToRomaji = (text: string): string => {
  const kanaMap: Record<string, string> = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'を': 'o', 'ん': 'n',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
    'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
    'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
    'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
    'ー': '', ' ': ' ',
  };

  let normalized = text.replace(/[\u30a1-\u30f6]/g, (match) => {
    return String.fromCharCode(match.charCodeAt(0) - 0x60);
  });

  let result = '';
  let i = 0;
  while (i < normalized.length) {
    if (i + 1 < normalized.length) {
      const doubleChar = normalized.substring(i, i + 2);
      if (kanaMap[doubleChar]) {
        result += kanaMap[doubleChar];
        i += 2;
        continue;
      }
    }
    
    const char = normalized[i];
    if (char === 'っ' && i + 1 < normalized.length) {
      const nextChar = normalized[i + 1];
      const nextRomaji = kanaMap[nextChar] || (i + 2 < normalized.length ? kanaMap[normalized.substring(i+1, i+3)] : '');
      if (nextRomaji) {
        result += nextRomaji[0];
      }
      i++;
      continue;
    }

    result += kanaMap[char] || char;
    i++;
  }
  return result;
};

const preprocessSearchQuery = (query: string): string => {
  const q = query.trim().toLowerCase();
  
  const JP_MOD_MAP: Record<string, string> = {
    // ユーザー指定: 木こりMOD, 黄昏の森
    '木こり': 'treechop',
    '木こりmod': 'treechop',
    'きこり': 'treechop',
    'きこりmod': 'treechop',
    '黄昏の森': 'twilight forest',
    '黄昏': 'twilight forest',
    'たそがれのもり': 'twilight forest',
    'たそがれ': 'twilight forest',
    'twilightforest': 'twilight forest',
    
    // 一般的な主要MOD
    'ソジウム': 'sodium',
    'ナトリウム': 'sodium',
    'そうじゅむ': 'sodium',
    'クリエイト': 'create',
    'くりえいと': 'create',
    'ジェイ': 'jei',
    'じぇい': 'jei',
    'アイテム検索': 'jei',
    'オプティファイン': 'optifine',
    'オプティ': 'optifine',
    'ウェイストーン': 'waystones',
    'うぇいすとーん': 'waystones',
    'ジャーニーマップ': 'journeymap',
    'じゃーにーまっぷ': 'journeymap',
    'ボタニア': 'botania',
    'ぼたにあ': 'botania',
    '一括破壊': 'ftb ultimine',
    '地図': 'journeymap',
    'マップ': 'journeymap',
    '整理': 'inventory profiles next',
    'インベントリ整理': 'inventory profiles next',
    '影': 'oculus',
    '影mod': 'oculus',
  };

  for (const [key, value] of Object.entries(JP_MOD_MAP)) {
    if (q === key || q.includes(key)) {
      return value;
    }
  }

  // 汎用ローマ字変換
  const hasJapanese = /[\u3040-\u30ff\u4e00-\u9faf]/.test(query);
  if (hasJapanese) {
    return convertKanaToRomaji(query);
  }
  return query;
};

// ==========================================
// MOD説明文の日本語「簡易翻訳」エンジン
// ==========================================
const translateDescription = (desc: string): string => {
  if (!desc) return '';
  
  const TRANS_PHRASES: [RegExp, string][] = [
    [/A modern rendering engine/i, 'モダンな描画（レンダリング）エンジン'],
    [/A performance mod/i, 'パフォーマンス向上（軽量化）MOD'],
    [/Adds a new dimension/i, '新しい次元（ディメンション）を追加'],
    [/Optimizes client performance/i, 'クライアントのパフォーマンスを極限まで最適化'],
    [/A fully-featured minimap/i, '多機能で美しいミニマップ'],
    [/Inventory management and organization/i, 'インベントリの自動管理および整理'],
    [/Allows you to cut down entire trees/i, '木を一発で根こそぎ伐採（木こり）できるようにする'],
    [/A magical mod/i, '魔法と神秘に満ちた大型魔術MOD'],
    [/Adds various utility tools/i, '様々な便利なユーティリティツールを追加'],
    [/Highly configurable/i, '高度なカスタマイズ・設定変更が可能'],
    [/Improves loading times/i, '起動時間やロード時間を劇的に高速化'],
  ];

  let translated = desc;
  for (const [regex, replacement] of TRANS_PHRASES) {
    translated = translated.replace(regex, replacement);
  }

  const WORD_MAP: Record<string, string> = {
    'Minecraft': 'マインクラフト',
    'minecraft': 'マインクラフト',
    'mod': 'MOD',
    'Mod': 'MOD',
    'mods': 'MOD群',
    'Mods': 'MOD群',
    'performance': 'パフォーマンス',
    'Performance': 'パフォーマンス',
    'optimize': '最適化',
    'optimizes': '最適化する',
    'optimization': '最適化',
    'rendering': 'レンダリング',
    'renderer': 'レンダラー',
    'minimap': 'ミニマップ',
    'map': '地図',
    'Map': '地図',
    'world': 'ワールド',
    'dimension': '次元',
    'dimensions': '次元群',
    'loader': 'ローダー',
    'loaders': 'ローダー群',
    'dependency': '前提MOD',
    'dependencies': '前提MOD群',
    'required': '必須',
    'optional': '任意',
    'recipe': 'レシピ',
    'recipes': 'レシピ群',
    'item': 'アイテム',
    'items': 'アイテム群',
    'block': 'ブロック',
    'blocks': 'ブロック群',
    'tool': 'ツール',
    'tools': 'ツール群',
    'inventory': 'インベントリ',
    'player': 'プレイヤー',
    'players': 'プレイヤーたち',
    'server': 'サーバー',
    'client': 'クライアント',
    'vanilla': 'バニラ',
    'features': '機能',
    'feature': '機能',
    'compatible': '互換性あり',
    'compatibility': '互換性',
  };

  for (const [eng, jap] of Object.entries(WORD_MAP)) {
    const regex = new RegExp(`\\b${eng}\\b`, 'gi');
    translated = translated.replace(regex, jap);
  }

  return translated;
};

// ==========================================
// カタカナ・あいうえお順ソート用簡易マッパー
// ==========================================
const getSortName = (title: string): string => {
  const t = title.toLowerCase();
  
  const NAME_TO_KANA: Record<string, string> = {
    'sodium': 'ソジウム',
    'create': 'クリエイト',
    'twilight forest': 'トワイライトフォレスト',
    'the twilight forest': 'トワイライトフォレスト',
    'jei': 'ジェイ',
    'just enough items': 'ジェイ',
    'optifine': 'オプティファイン',
    'waystones': 'ウェイストーン',
    'journeymap': 'ジャーニーマップ',
    'botania': 'ボタニア',
    'ftb ultimine': 'エフティービーウルティマイン',
    'treechop': 'ツリーチョップ',
    'ht\'s treechop': 'ツリーチョップ',
    'falling tree': 'フォーリングツリー',
    'fallingtree': 'フォーリングツリー',
    'oculus': 'オキュラス',
    'iris shaders': 'アイリスシェーダー',
  };

  for (const [key, val] of Object.entries(NAME_TO_KANA)) {
    if (t.includes(key)) return val;
  }
  return title;
};

export default function NewPresetPage() {
  const [name, setName] = useState('');
  const [mcVersion, setMcVersion] = useState('1.20.1');
  const [loader, setLoader] = useState('forge');
  
  // 検索・追加のステート
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ModItem[]>([]);
  const [selectedMods, setSelectedMods] = useState<ModItem[]>([]);
  const [saving, setSaving] = useState(false);

  // 高度な絞り込み・ソート用のステート
  const [filterLoader, setFilterLoader] = useState('all');
  const [filterSource, setFilterSource] = useState('all');
  const [sortBy, setSortBy] = useState('default');
  const [showTranslation, setShowTranslation] = useState(true); // デフォルトで翻訳ONにして親切に

  const router = useRouter();

  // リアルタイム横断検索
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      setSearching(true);
      // カタカナ・ひらがな➔アルファベット自動変換を適用
      const processedQuery = preprocessSearchQuery(searchQuery);
      console.log(`[Search] Querying mods for raw: "${searchQuery}", processed: "${processedQuery}"`);
      
      const data = await apiFetch(
        `/api/mods/search?q=${encodeURIComponent(processedQuery)}&mc_version=${mcVersion}&loader=${loader}`
      );
      setSearchResults(data.mods || []);
    } catch (err: any) {
      alert(`検索エラー: ${err.message}`);
    } finally {
      setSearching(false);
    }
  };

  // MODの追加（マスタDBに未登録なら自動登録）
  const handleAddMod = async (mod: ModItem) => {
    // 既に追加済みなら無視
    if (selectedMods.some(m => m.id === mod.id && m.source === mod.source)) {
      return;
    }

    try {
      // 1. バックエンドに登録して正式な UUID を取得
      const cached = await apiFetch('/api/mods', {
        method: 'POST',
        body: JSON.stringify({
          source: mod.source || 'modrinth',
          external_id: mod.id, // ModrinthのIDまたはCurseForgeのProjectID
          name: mod.title,
          mc_version: mcVersion,
          loader: loader,
          download_url: mod.download_url || '',
          client_side: mod.client_side || 'optional',
          server_side: mod.server_side || 'optional',
        }),
      });

      // 2. D1 上の UUID を使って選択リストに追加
      const newModItem: ModItem = {
        ...mod,
        id: cached.id, // D1 内の UUID に差し替え
      };

      setSelectedMods([...selectedMods, newModItem]);
      // 検索結果から消す（または選択済みにする）
      setSearchResults(searchResults.filter(m => m.id !== mod.id));
    } catch (err: any) {
      alert(`MOD追加エラー: ${err.message}`);
    }
  };

  // 選択MODの削除
  const handleRemoveMod = (id: string) => {
    setSelectedMods(selectedMods.filter(m => m.id !== id));
  };

  // 保存処理
  const handleSave = async () => {
    if (!name.trim()) {
      alert('プリセット名を入力してください。');
      return;
    }

    try {
      setSaving(true);
      console.log(`[Presets] Saving preset: ${name}`);
      const modIds = selectedMods.map(m => m.id);

      await apiFetch('/api/presets', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          mc_version: mcVersion,
          loader: loader,
          mod_ids: modIds,
        }),
      });

      // 保存成功後、一覧へ戻る
      router.push('/dashboard/presets');
    } catch (err: any) {
      alert(`保存失敗: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ==========================================
  // クライアントサイドでの絞り込みと並び替えロジック
  // ==========================================
  const displayResults = React.useMemo(() => {
    let list = [...searchResults];

    // 1. ソースでの絞り込み
    if (filterSource !== 'all') {
      list = list.filter(m => (m.source || 'modrinth') === filterSource);
    }

    // 2. ローダーでの絞り込み
    if (filterLoader !== 'all') {
      list = list.filter(m => {
        const desc = (m.description || '').toLowerCase();
        const title = (m.title || '').toLowerCase();
        // API検索で基本絞り込まれているが、クライアントサイドで確実にする
        return desc.includes(filterLoader) || title.includes(filterLoader) || (m as any).loader === filterLoader;
      });
    }

    // 3. 並び替え (Sorting)
    if (sortBy === 'name-asc') {
      list.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortBy === 'name-desc') {
      list.sort((a, b) => b.title.localeCompare(a.title));
    } else if (sortBy === 'kana-asc') {
      // カタカナ・あいうえお順でソート
      list.sort((a, b) => getSortName(a.title).localeCompare(getSortName(b.title), 'ja'));
    } else if (sortBy === 'kana-desc') {
      list.sort((a, b) => getSortName(b.title).localeCompare(getSortName(a.title), 'ja'));
    }

    return list;
  }, [searchResults, filterLoader, filterSource, sortBy]);

  return (
    <div>
      <div style={{ marginBottom: '2.5rem' }}>
        <h2>新規プリセット作成</h2>
        <p style={{ color: '#9ca3af', marginTop: '0.6rem', fontSize: '0.95rem', fontFamily: 'Inter, sans-serif' }}>
          マイクラのバージョンと導入するMODを選択してください。
        </p>
      </div>

      <GlassCard variant="stone" style={{ padding: '2.5rem', marginBottom: '3rem' }}>
        <div className={styles.formContainer}>
          {/* 基本設定 */}
          <div className={styles.formGroup}>
            <label className={styles.label}>プリセット名</label>
            <input 
              type="text" 
              className={styles.input} 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: フレンド用 1.20.1 Forgeパック" 
              style={{ fontFamily: 'Inter, sans-serif' }} 
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Minecraft バージョン</label>
              <select 
                className={styles.select} 
                value={mcVersion}
                onChange={(e) => {
                  setMcVersion(e.target.value);
                  setSearchResults([]); // 環境が変わったら検索結果をリセット
                }}
                style={{ fontFamily: 'Inter, sans-serif' }}
              >
                <option value="1.20.4">1.20.4</option>
                <option value="1.20.1">1.20.1</option>
                <option value="1.19.4">1.19.4</option>
              </select>
            </div>
            
            <div className={styles.formGroup}>
              <label className={styles.label}>ローダー</label>
              <select 
                className={styles.select} 
                value={loader}
                onChange={(e) => {
                  setLoader(e.target.value);
                  setSearchResults([]); // 環境が変わったら検索結果をリセット
                }}
                style={{ fontFamily: 'Inter, sans-serif' }}
              >
                <option value="forge">Forge</option>
                <option value="fabric">Fabric</option>
                <option value="neoforge">NeoForge</option>
                <option value="quilt">Quilt</option>
              </select>
            </div>
          </div>

          {/* 選択済みのMOD一覧 */}
          {selectedMods.length > 0 && (
            <div style={{ marginBottom: '2.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', color: '#ffffff', marginBottom: '1rem', fontWeight: 'bold' }}>選択中のMOD ({selectedMods.length}件)</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.8rem' }}>
                {selectedMods.map(mod => (
                  <div 
                    key={mod.id} 
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '6px',
                      padding: '0.4rem 0.8rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.8rem',
                      fontSize: '0.9rem'
                    }}
                  >
                    <span style={{ color: '#ffffff', fontWeight: '500' }}>{mod.title}</span>
                    <span style={{ 
                      fontSize: '0.7rem',
                      background: mod.source === 'curseforge' ? 'rgba(239, 104, 38, 0.15)' : 'rgba(34, 211, 238, 0.15)',
                      color: mod.source === 'curseforge' ? '#ef6826' : '#22d3ee',
                      padding: '0.08rem 0.35rem',
                      borderRadius: '3px',
                      fontWeight: '700'
                    }}>
                      {mod.source || 'MODRINTH'}
                    </span>
                    <button 
                      onClick={() => handleRemoveMod(mod.id)} 
                      style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: '#ef4444', 
                        cursor: 'pointer',
                        padding: '0 0.2rem',
                        fontSize: '1rem',
                        fontWeight: 'bold'
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* オンライン横断検索ボックス */}
          <div className={styles.searchBox}>
            <h3 style={{ marginBottom: '0.8rem' }}>MODオンライン横断検索 (Modrinth & CurseForge API)</h3>
            <form onSubmit={handleSearch} style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
              <input 
                type="text" 
                className={styles.input} 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ flex: '1 1 220px', minWidth: 0, fontFamily: 'Inter, sans-serif' }} 
                placeholder="例: Create, Waystones, Sodium..." 
              />
              <Button variant="secondary" type="submit" disabled={searching}>
                {searching ? '検索中...' : '検索'}
              </Button>
            </form>

            {/* 絞り込み＆ソートツールバー (Glassmorphic仕様) */}
            {searchResults.length > 0 && !searching && (
              <div style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '8px',
                padding: '1rem 1.5rem',
                marginBottom: '1.5rem',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '1.5rem',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '0.88rem'
              }}>
                <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* ソース絞り込み */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#9ca3af' }}>ソース:</span>
                    <select 
                      value={filterSource}
                      onChange={(e) => setFilterSource(e.target.value)}
                      style={{
                        background: 'rgba(0, 0, 0, 0.3)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        color: '#ffffff',
                        padding: '0.2rem 0.6rem',
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif'
                      }}
                    >
                      <option value="all">すべて</option>
                      <option value="modrinth">Modrinth</option>
                      <option value="curseforge">CurseForge</option>
                    </select>
                  </div>

                  {/* ローダー絞り込み */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#9ca3af' }}>ローダー:</span>
                    <select 
                      value={filterLoader}
                      onChange={(e) => setFilterLoader(e.target.value)}
                      style={{
                        background: 'rgba(0, 0, 0, 0.3)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        color: '#ffffff',
                        padding: '0.2rem 0.6rem',
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif'
                      }}
                    >
                      <option value="all">すべて</option>
                      <option value="forge">Forge</option>
                      <option value="fabric">Fabric</option>
                      <option value="neoforge">NeoForge</option>
                      <option value="quilt">Quilt</option>
                    </select>
                  </div>

                  {/* 並び替え */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#9ca3af' }}>並び替え:</span>
                    <select 
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      style={{
                        background: 'rgba(0, 0, 0, 0.3)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        color: '#ffffff',
                        padding: '0.2rem 0.6rem',
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif'
                      }}
                    >
                      <option value="default">デフォルト順</option>
                      <option value="name-asc">アルファベット順 (A-Z)</option>
                      <option value="name-desc">アルファベット順 (Z-A)</option>
                      <option value="kana-asc">あいうえお順 (ア-ン)</option>
                      <option value="kana-desc">あいうえお順 (ン-ア)</option>
                    </select>
                  </div>
                </div>

                {/* 翻訳トグル */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', color: '#ffffff' }}>
                    <input 
                      type="checkbox" 
                      checked={showTranslation}
                      onChange={(e) => setShowTranslation(e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: '#10b981' }}
                    />
                    <span>説明文を日本語に翻訳</span>
                  </label>
                </div>
              </div>
            )}

            {/* 検索結果リスト */}
            {searching ? (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '1.5rem', fontFamily: 'Inter, sans-serif' }}>
                公式APIよりリアルタイム検索中...
              </p>
            ) : displayResults.length > 0 ? (
              <div>
                {/* 検索時マッピングがあった場合のインフォメーション */}
                {searchQuery !== preprocessSearchQuery(searchQuery) && (
                  <div style={{
                    fontSize: '0.85rem',
                    color: '#34d399',
                    background: 'rgba(52, 211, 153, 0.08)',
                    border: '1px solid rgba(52, 211, 153, 0.15)',
                    borderRadius: '6px',
                    padding: '0.5rem 1rem',
                    marginBottom: '1rem',
                    fontFamily: 'Inter, sans-serif'
                  }}>
                    💡 日本語検索アシスト: <strong>「{searchQuery}」</strong> を <strong>「{preprocessSearchQuery(searchQuery)}」</strong> に自動変換して検索しました。
                  </div>
                )}

                <div className={styles.modList}>
                  {displayResults.map(mod => (
                    <div key={mod.id} className={styles.modItem}>
                      <div className={styles.modInfo}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                          <h4 style={{ margin: 0, fontSize: '1.1rem', color: '#ffffff' }}>{mod.title}</h4>
                          <span style={{ 
                            fontSize: '0.72rem',
                            background: mod.source === 'curseforge' ? 'rgba(239, 104, 38, 0.15)' : 'rgba(34, 211, 238, 0.15)',
                            color: mod.source === 'curseforge' ? '#ef6826' : '#22d3ee',
                            padding: '0.08rem 0.45rem',
                            borderRadius: '4px',
                            fontWeight: '700',
                            textTransform: 'uppercase'
                          }}>
                            {mod.source || 'MODRINTH'}
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
                        <div className={styles.modDesc}>
                          {showTranslation ? translateDescription(mod.description) : mod.description}
                        </div>
                      </div>
                      <Button variant="primary" onClick={() => handleAddMod(mod)}>追加</Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : searchQuery && (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '1.5rem', fontFamily: 'Inter, sans-serif' }}>
                該当するMODが見つかりません。環境設定 (バージョン: {mcVersion}, ローダー: {loader}) に対応しているか確認してください。
              </p>
            )}
          </div>

          {/* 送信・キャンセルボタン */}
          <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '1rem' }}>
            <Button variant="secondary" href="/dashboard/presets">キャンセル</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? '保存中...' : '保存して完了'}
            </Button>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}


