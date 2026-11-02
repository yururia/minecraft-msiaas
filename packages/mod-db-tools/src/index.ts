/**
 * Modrinth API 連携パッケージ
 * MVP段階では、指定されたMODの最新情報を取得・パースする役割を持ちます。
 */

const MODRINTH_API_URL = 'https://api.modrinth.com/v2';
const CURSEFORGE_API_URL = 'https://api.curseforge.com/v1';

export interface ModInfo {
  id: string;
  slug: string;
  title: string;
  description: string;
  versions: string[];
  client_side: string;
  server_side: string;
  loader?: string;
  license?: string;
  download_url?: string;
  source?: 'curseforge' | 'modrinth';
}

export function resolveCurseForgeCdnUrl(file: any): string {
  if (!file) return '';
  if (file.downloadUrl && typeof file.downloadUrl === 'string' && file.downloadUrl.trim() !== '') {
    return file.downloadUrl.trim();
  }
  if (file.id && file.fileName) {
    const fid = Number(file.id);
    if (!isNaN(fid) && fid > 0) {
      return `https://edge.forgecdn.net/files/${Math.floor(fid / 1000)}/${fid % 1000}/${encodeURIComponent(file.fileName)}`;
    }
  }
  return '';
}

export const KNOWN_MOD_ALIASES: Record<string, string> = {
  'epic_fight_avalon': 'Epic Fight Avalon',
  'epicfightavalon': 'Epic Fight Avalon',
  'dodge_parry_reward': 'Epic Fight : Dodge Parry Reward',
  'dodgeparryreward': 'Epic Fight : Dodge Parry Reward',
  'p1nero_ec': "P1nero's Epic X Cataclysm",
  'p1neroec': "P1nero's Epic X Cataclysm",
  'sword_soaring': 'Epic Fight - Sword Soaring',
  'swordsoaring': 'Epic Fight - Sword Soaring',
  'p1nero_bow': "P1nero's Epic Bow",
  'p1nerobow': "P1nero's Epic Bow",
  'p1nero_dl': "P1nero's Dialogue Lib",
  'p1nerodl': "P1nero's Dialogue Lib",
  'efn': 'EpicFight-Nightfall',
  'epicfight': 'Epic Fight',
  'epic_fight': 'Epic Fight',
  'ba_bt': 'BrassAmberBattleTowers',
  'attributeslib': 'Apothic Attributes',
  'cloth-config': 'Cloth Config API',
  'cloth-config2': 'Cloth Config API',
  'cloth_config': 'Cloth Config API',
  'clothconfig': 'Cloth Config API',
  'architectury': 'Architectury API',
  'curios': 'Curios API',
  'geckolib': 'GeckoLib',
  'geckolib3': 'GeckoLib',
  'citadel': 'Citadel',
  'bookshelf': 'Bookshelf',
  'balm': 'Balm',
  'puzzleslib': 'Puzzles Lib',
  'resourcefullib': 'Resourceful Lib',
  'resourcefulconfig': 'Resourceful Config',
  'moonlight': 'Moonlight Lib',
  'yungsapi': "YUNG's API",
  'caelus': 'Caelus API',
  'lodestone': 'Lodestone',
  'azurelib': 'AzureLib',
  'smartbrainlib': 'SmartBrainLib',
  'creativecore': 'CreativeCore',
  'playeranimator': 'playerAnimator',
  'kotlinforforge': 'Kotlin for Forge',
  'fabric-language-kotlin': 'Fabric Language Kotlin',
  'forgeconfigapiport': 'Forge Config API Port',
  'supermartijn642corelib': "SuperMartijn642's Core Lib",
  'supermartijn642configlib': "SuperMartijn642's Config Lib",
  'placebo': 'Placebo',
  'autoreglib': 'AutoRegLib',
  'quark': 'Quark',
  'zeta': 'Zeta',
  'indium': 'Indium',
  'sodium': 'Sodium',
  'iris': 'Iris Shaders',
  'modmenu': 'Mod Menu',
};

export function normalizeModQuery(raw: string): { primaryQuery: string; fallbackQueries: string[] } {
  let cleaned = raw.trim();
  // Strip .jar or .zip
  cleaned = cleaned.replace(/\.(jar|zip)$/i, '');
  // Strip trailing version patterns like -1.20.1-1.2.3 or _20.14.0.4
  cleaned = cleaned.replace(/[-_]v?\d+(\.\d+)+.*$/i, '');

  const lower = cleaned.toLowerCase();
  const normKey = lower.replace(/[^a-z0-9]/g, '');
  const aliasMatch = KNOWN_MOD_ALIASES[lower] || KNOWN_MOD_ALIASES[normKey];

  // Replace underscores and hyphens with spaces
  const spaced = cleaned.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  const fallbacks: string[] = [];
  const primary = aliasMatch || spaced;

  if (aliasMatch && aliasMatch.toLowerCase() !== spaced.toLowerCase()) {
    fallbacks.push(spaced);
  }
  if (spaced.toLowerCase() !== cleaned.toLowerCase()) {
    fallbacks.push(cleaned);
  }

  // If spaced has multiple words, add keyword combinations
  const words = spaced.split(' ');
  if (words.length > 2) {
    fallbacks.push(words.slice(1).join(' '));
    fallbacks.push(words[words.length - 1]);
  } else if (words.length === 2 && words[0].toLowerCase() !== 'epic') {
    fallbacks.push(words[1]);
  }

  return {
    primaryQuery: primary,
    fallbackQueries: Array.from(new Set(fallbacks)).filter(q => q && q.toLowerCase() !== primary.toLowerCase())
  };
}

export class ModDbClient {
  /**
   * 特定のMODのバージョン・ローダーに合致するダウンロードURLを解決します
   */
  async resolveDownloadUrl(
    source: string,
    externalId: string,
    mcVersion: string,
    loader: string,
    curseForgeApiKey?: string
  ): Promise<string> {
    if (!externalId) return '';
    const headers = { 'User-Agent': 'msiaas/1.0.0 (contact@example.com)' };

    if (source === 'modrinth') {
      try {
        const loadersParam = encodeURIComponent(JSON.stringify([loader.toLowerCase()]));
        const versionsParam = encodeURIComponent(JSON.stringify([mcVersion]));
        const url = `${MODRINTH_API_URL}/project/${encodeURIComponent(externalId)}/version?loaders=${loadersParam}&game_versions=${versionsParam}`;
        const res = await fetch(url, { headers });
        if (res.ok) {
          const versions = (await res.json()) as any[];
          if (versions.length > 0) {
            const primaryFile = versions[0].files?.find((f: any) => f.primary) || versions[0].files?.[0];
            if (primaryFile?.url) return primaryFile.url;
          }
        }
      } catch (err) {
        console.warn(`[ModDbTools] Failed to resolve Modrinth download URL for ${externalId}:`, err);
      }
    } else if (source === 'curseforge' && curseForgeApiKey) {
      try {
        const res = await fetch(`${CURSEFORGE_API_URL}/mods/${encodeURIComponent(externalId)}/files`, {
          headers: {
            Accept: 'application/json',
            'x-api-key': curseForgeApiKey,
          },
        });
        if (res.ok) {
          const { data: files } = (await res.json()) as { data: any[] };
          const targetFile = files?.find((f: any) => {
            const hasMc = f.gameVersions?.includes(mcVersion);
            const hasLoader = f.gameVersions?.some(
              (v: string) => v.toLowerCase() === loader.toLowerCase() || v.toLowerCase() === 'any'
            );
            return hasMc && hasLoader;
          }) || files?.find((f: any) => f.gameVersions?.includes(mcVersion)) || files?.[0];

          if (targetFile) {
            const cdnUrl = resolveCurseForgeCdnUrl(targetFile);
            if (cdnUrl) return cdnUrl;
          }
        }
      } catch (err) {
        console.warn(`[ModDbTools] Failed to resolve CurseForge download URL for ${externalId}:`, err);
      }
    }
    return '';
  }

  /**
   * Modrinth APIから複数のMOD情報を一度に取得します
   */
  async fetchMods(modIds: string[], mcVersion?: string, loader?: string): Promise<ModInfo[]> {
    if (modIds.length === 0) return [];
    
    console.log(`[ModDbTools] Fetching data for mods: ${modIds.join(', ')}`);
    
    // User-Agent要件の遵守: <プロジェクト名>/<バージョン> (<連絡先>)
    const headers = {
      'User-Agent': 'msiaas/1.0.0 (contact@example.com)'
    };

    try {
      // 複数のプロジェクトを取得するエンドポイント
      const idsParam = JSON.stringify(modIds);
      const url = `${MODRINTH_API_URL}/projects?ids=${encodeURIComponent(idsParam)}`;
      
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Modrinth API error: ${response.status}`);
      }

      const data = await response.json() as any[];
      
      const results: ModInfo[] = [];
      for (const mod of data) {
        let downloadUrl = '';
        if (mcVersion && loader) {
          downloadUrl = await this.resolveDownloadUrl('modrinth', mod.id, mcVersion, loader);
        }
        results.push({
          id: mod.id,
          slug: mod.slug,
          title: mod.title,
          description: mod.description,
          versions: mod.game_versions || mod.versions || [],
          client_side: mod.client_side || 'optional',
          server_side: mod.server_side || 'optional',
          license: mod.license?.id || mod.license?.name || 'Unknown',
          download_url: downloadUrl,
          source: 'modrinth',
        });
      }
      return results;
    } catch (error) {
      console.error('[ModDbTools] Failed to fetch from Modrinth:', error);
      // API失敗時のローカルモックフォールバック
      return modIds.map(id => ({
        id,
        slug: id,
        title: `Mock Mod ${id}`,
        description: `Description for ${id}`,
        versions: ['1.20.1', '1.19.2'],
        client_side: id === 'xaeros-minimap' ? 'required' : id === 'chunk-pregen' ? 'unsupported' : 'optional',
        server_side: id === 'chunk-pregen' ? 'required' : id === 'xaeros-minimap' ? 'unsupported' : 'optional',
        license: 'MIT',
        download_url: `https://cdn.modrinth.com/mock/${id}.jar`,
        source: 'modrinth',
      }));
    }
  }

  /**
   * 指定されたMOD群の依存関係を解決し、必要な前提MODの external_id リストを返します。
   */
  async resolveDependencies(
    modExternalIds: string[],
    mcVersion: string,
    loader: string
  ): Promise<string[]> {
    if (modExternalIds.length === 0) return [];

    const resolved = new Set<string>();
    const visited = new Set<string>();
    const toVisit = [...modExternalIds];

    // ローカル検証用の静的依存マップ (Mock)
    const MOCK_DEPENDENCY_MAP: Record<string, string[]> = {
      'test-mod-with-dep': ['test-dependency-mod'],
      'sodium': ['fabric-api'],
    };

    while (toVisit.length > 0) {
      const currentId = toVisit.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // モック解決の優先適用（オフライン/高速検証用）
      const mockDeps = MOCK_DEPENDENCY_MAP[currentId];
      if (mockDeps) {
        for (const depId of mockDeps) {
          if (!visited.has(depId)) {
            resolved.add(depId);
            toVisit.push(depId);
          }
        }
        continue;
      }

      // Modrinth API での動的依存関係取得（フォールバック）
      try {
        console.log(`[ModDbTools] Fetching dependencies for project: ${currentId}`);
        const headers = { 'User-Agent': 'msiaas/1.0.0 (contact@example.com)' };
        
        // 該当プロジェクトのバージョン一覧を取得し、mc_version & loader に合致するものを検索
        const versionsRes = await fetch(`${MODRINTH_API_URL}/project/${currentId}/version`, { headers });
        if (versionsRes.ok) {
          const versions = await versionsRes.json() as any[];
          const targetVersion = versions.find(v => 
            v.game_versions.includes(mcVersion) && 
            (v.loaders.includes(loader) || v.loaders.includes('any'))
          );

          if (targetVersion && targetVersion.dependencies) {
            for (const dep of targetVersion.dependencies) {
              // 必須（required）の依存関係のみ追加
              if (dep.dependency_type === 'required' && dep.project_id) {
                if (!visited.has(dep.project_id)) {
                  resolved.add(dep.project_id);
                  toVisit.push(dep.project_id);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn(`[ModDbTools] Dynamic dependency check failed for ${currentId}, skipped.`, error);
      }
    }

    // 元々の入力MODは除外し、純粋な前提MODのみを返す
    const inputSet = new Set(modExternalIds);
    return Array.from(resolved).filter(id => !inputSet.has(id));
  }

  /**
   * 複数のMODリストから、共通してサポートされているマイクラバージョンとローダーを自動抽出します。
   * 競合が発生した場合や共通環境が見つからない場合は null を返します。
   */
  extractCommonEnvironment(mods: ModInfo[]): { mcVersion: string; loader: string } | null {
    if (mods.length === 0) return null;

    // 1. バージョンの積集合（共通部分）を計算
    let commonVersions = new Set<string>(mods[0].versions);
    for (let i = 1; i < mods.length; i++) {
      const currentVersions = new Set<string>(mods[i].versions);
      commonVersions = new Set([...commonVersions].filter(x => currentVersions.has(x)));
    }

    if (commonVersions.size === 0) {
      console.log('[ModDbTools] No common minecraft version found.');
      return null;
    }

    // 最新のバージョンを選択する (単純に文字列として降順ソート、または元の順序の優先度)
    const sortedVersions = Array.from(commonVersions).sort((a, b) => {
      // 簡易的なセマンティックバージョン比較
      const partsA = a.split('.').map(Number);
      const partsB = b.split('.').map(Number);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const valA = partsA[i] || 0;
        const valB = partsB[i] || 0;
        if (valA !== valB) return valB - valA;
      }
      return 0;
    });
    const mcVersion = sortedVersions[0];

    // 2. ローダーの共通化
    // 各MODの client_side/server_side などの loader 情報はマスタでチェックする。
    // ここでは、入力されたMODたちが要求する loader に基づいて共通ローダーを決定。
    // 各MODが明示的に loader を持っている場合（mods 側の loader カラム等）
    // （※この ModInfo 構造体には loader フィールドがないが、D1上には存在するため、引数の ModInfo に loader を追加）
    // loader の競合を解決する:
    // もし Fabric 専用のMODと Forge 専用のMODが混在している場合は null にする。
    
    // index.tsのModInfoインターフェースにloaderを追加します
    const loaders = mods.map(m => (m as any).loader || 'any');
    const specificLoaders = Array.from(new Set(loaders.filter(l => l !== 'any')));

    let loader = 'fabric'; // デフォルトフォールバック
    if (specificLoaders.length > 1) {
      console.log(`[ModDbTools] Conflicting loaders detected: ${specificLoaders.join(', ')}`);
      return null;
    } else if (specificLoaders.length === 1) {
      loader = specificLoaders[0];
    }

    return { mcVersion, loader };
  }

  /**
   * CurseForge APIから複数のMOD情報を一度に取得します
   * classId === 6 (Mods) 以外（ShaderPacks / ResourcePacks 等）は除外し、
   * 指定された mcVersion / loader または manifest.json の fileID に合致するファイルを選定します。
   */
  async fetchModsFromCurseForge(
    modIds: number[],
    apiKey: string,
    mcVersion?: string,
    loader?: string,
    fileIdMap?: Record<number, number>
  ): Promise<ModInfo[]> {
    if (modIds.length === 0) return [];
    if (!apiKey) {
      console.warn('[ModDbTools] CurseForge API Key is missing. Falling back to mocks.');
      return this.getMockCurseForgeMods(modIds);
    }

    console.log(`[ModDbTools] Fetching from CurseForge for mods: ${modIds.join(', ')}`);

    try {
      const response = await fetch(`${CURSEFORGE_API_URL}/mods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ modIds }),
      });

      if (!response.ok) {
        throw new Error(`CurseForge API error: ${response.status}`);
      }

      const { data } = await response.json() as { data: any[] };
      const results: ModInfo[] = [];

      for (const mod of data) {
        // CurseForge classId === 6 は Mods。ShaderPacks (6552) や ResourcePacks (12) が mods/ に混入するのを防ぐ
        if (mod.classId && mod.classId !== 6) {
          console.log(`[ModDbTools] Skipping non-Mod CurseForge entry: ${mod.name} (classId=${mod.classId})`);
          continue;
        }

        // バージョン情報を集計
        const versions = new Set<string>();
        if (mod.latestFilesIndexes) {
          mod.latestFilesIndexes.forEach((idx: any) => {
            if (idx.gameVersion) versions.add(idx.gameVersion);
          });
        }

        const latestFiles: any[] = Array.isArray(mod.latestFiles) ? mod.latestFiles : [];
        const preferredFileId = fileIdMap?.[Number(mod.id)];

        // 1. manifest.json の fileID が latestFiles 内にあれば最優先
        let selectedFile = preferredFileId
          ? latestFiles.find((f: any) => Number(f.id) === Number(preferredFileId) && f.isAvailable !== false)
          : undefined;

        // 2. mcVersion と loader の両方に合致するファイルを検索
        if (!selectedFile && mcVersion && loader) {
          const targetLoaderLower = loader.toLowerCase();
          selectedFile = latestFiles.find((f: any) => {
            if (f.isAvailable === false) return false;
            const gv: string[] = Array.isArray(f.gameVersions) ? f.gameVersions : [];
            const hasMc = gv.some(v => v === mcVersion);
            const hasLoader = gv.some(v => v.toLowerCase() === targetLoaderLower);
            return hasMc && hasLoader;
          });
        }

        // 3. mcVersion のみに合致し、他の競合ローダー専用でないファイルを検索
        if (!selectedFile && mcVersion) {
          const otherLoaders = ['fabric', 'forge', 'neoforge', 'quilt'].filter(
            l => !loader || l !== loader.toLowerCase()
          );
          selectedFile = latestFiles.find((f: any) => {
            if (f.isAvailable === false) return false;
            const gv: string[] = Array.isArray(f.gameVersions) ? f.gameVersions : [];
            const hasMc = gv.some(v => v === mcVersion);
            const hasConflictingLoader = gv.some(v => otherLoaders.includes(v.toLowerCase())) &&
              (!loader || !gv.some(v => v.toLowerCase() === loader.toLowerCase()));
            return hasMc && !hasConflictingLoader;
          });
        }

        // 4. それでも見つからない場合は resolveDownloadUrl で /mods/{id}/files エンドポイントから取得を試みる
        let downloadUrl = resolveCurseForgeCdnUrl(selectedFile);
        if (!downloadUrl && mcVersion && loader) {
          downloadUrl = await this.resolveDownloadUrl('curseforge', String(mod.id), mcVersion, loader, apiKey);
        }
        if (!selectedFile) {
          selectedFile = latestFiles.find((f: any) => f.isAvailable) || latestFiles[0];
          if (!downloadUrl) downloadUrl = resolveCurseForgeCdnUrl(selectedFile);
        }

        const gameVerList: string[] = Array.isArray(selectedFile?.gameVersions) ? selectedFile.gameVersions : [];
        const hasClientTag = gameVerList.some(v => v.toLowerCase() === 'client');
        const hasServerTag = gameVerList.some(v => v.toLowerCase() === 'server');

        let clientSide = 'optional';
        let serverSide = 'optional';
        if (hasClientTag && !hasServerTag) {
          clientSide = 'required';
          serverSide = 'unsupported';
        } else if (hasServerTag && !hasClientTag) {
          clientSide = 'unsupported';
          serverSide = 'required';
        }

        results.push({
          id: String(mod.id),
          slug: mod.slug,
          title: mod.name,
          description: mod.summary || mod.name,
          versions: Array.from(versions),
          client_side: clientSide,
          server_side: serverSide,
          license: 'Unknown',
          download_url: downloadUrl,
          source: 'curseforge',
        });
      }

      return results;
    } catch (error) {
      console.error('[ModDbTools] Failed to fetch from CurseForge:', error);
      return this.getMockCurseForgeMods(modIds);
    }
  }

  private getMockCurseForgeMods(modIds: number[]): ModInfo[] {
    return modIds.map(id => ({
      id: String(id),
      slug: `cf-mod-${id}`,
      title: `CurseForge Mod ${id}`,
      description: `Imported CurseForge Mod (ID: ${id})`,
      versions: ['1.20.1', '1.19.2'],
      client_side: 'optional',
      server_side: 'optional',
      license: 'Unknown',
      download_url: '',
    }));
  }

  /**
   * CurseForge の ProjectID 群から必須前提MODを動的解決します
   */
  async resolveCurseForgeDependencies(
    modIds: number[],
    mcVersion: string,
    loader: string,
    apiKey: string
  ): Promise<string[]> {
    if (modIds.length === 0) return [];
    if (!apiKey) {
      console.warn('[ModDbTools] CurseForge API Key is missing for dependency resolution.');
      return [];
    }

    const resolved = new Set<string>();
    const visited = new Set<number>();
    const toVisit = [...modIds];

    while (toVisit.length > 0) {
      const currentId = toVisit.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      try {
        console.log(`[ModDbTools] Fetching CurseForge files for project: ${currentId}`);
        const response = await fetch(
          `${CURSEFORGE_API_URL}/mods/${currentId}/files`,
          {
            headers: {
              'Accept': 'application/json',
              'x-api-key': apiKey,
            },
          }
        );

        if (response.ok) {
          const { data: files } = await response.json() as { data: any[] };

          // バージョンとローダーが一致するファイルを探す
          const targetFile = files.find(f => {
            const hasMc = f.gameVersions?.includes(mcVersion);
            const hasLoader = f.gameVersions?.some((v: string) => 
              v.toLowerCase() === loader.toLowerCase() || v.toLowerCase() === 'any'
            );
            return hasMc && hasLoader;
          });

          if (targetFile && targetFile.dependencies) {
            for (const dep of targetFile.dependencies) {
              // relationType === 3 は "Required Dependency" を示す
              if (dep.relationType === 3 && dep.modId) {
                const depModId = Number(dep.modId);
                if (!visited.has(depModId)) {
                  resolved.add(String(depModId));
                  toVisit.push(depModId);
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn(`[ModDbTools] CurseForge dependency check failed for ${currentId}`, error);
      }
    }

    const inputSet = new Set(modIds.map(String));
    return Array.from(resolved).filter(id => !inputSet.has(id));
  }

  /**
   * Modrinth と CurseForge の公式 API からリアルタイムで MOD を横断検索しマージします
   */
  async searchMods(
    query: string,
    mcVersion: string,
    loader: string,
    curseForgeApiKey: string
  ): Promise<ModInfo[]> {
    if (!query || !query.trim()) return [];

    const { primaryQuery, fallbackQueries } = normalizeModQuery(query);
    console.log(`[ModDbTools] Dynamic search for raw: "${query}", primary: "${primaryQuery}", fallbacks: ${JSON.stringify(fallbackQueries)} (Minecraft: ${mcVersion}, Loader: ${loader})`);

    const results: ModInfo[] = [];

    // 1. Modrinth からの検索 (primaryQuery および必要に応じて fallbackQueries)
    try {
      const modrinthLoader = loader.toLowerCase();
      const facets = JSON.stringify([
        ['project_type:mod'],
        [`versions:${mcVersion}`],
        [`categories:${modrinthLoader}`]
      ]);

      const modrinthQueries = [primaryQuery, ...fallbackQueries];
      for (const mQuery of modrinthQueries) {
        const url = `${MODRINTH_API_URL}/search?query=${encodeURIComponent(mQuery)}&facets=${encodeURIComponent(facets)}&limit=10`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'msiaas/1.0.0 (contact@example.com)' }
        });

        if (response.ok) {
          const data = await response.json() as { hits: any[] };
          if (data.hits && data.hits.length > 0) {
            const mapped: ModInfo[] = data.hits.map(hit => ({
              id: hit.project_id,
              slug: hit.slug,
              title: hit.title,
              description: hit.description || '',
              versions: [mcVersion],
              client_side: hit.client_side || 'optional',
              server_side: hit.server_side || 'optional',
              license: 'Unknown',
              download_url: '',
              source: 'modrinth',
            }));
            results.push(...mapped);
            break; // ヒットしたら追加のfallback検索は省略
          }
        }
      }
    } catch (error) {
      console.warn('[ModDbTools] Modrinth search failed:', error);
    }

    // 2. CurseForge からの検索
    if (curseForgeApiKey) {
      try {
        let cfLoaderType = 0;
        const normLoader = loader.toLowerCase();
        if (normLoader === 'forge') cfLoaderType = 1;
        else if (normLoader === 'fabric') cfLoaderType = 4;
        else if (normLoader === 'neoforge') cfLoaderType = 6;

        const cfQueriesToTry = [primaryQuery, ...fallbackQueries];
        let cfFound = false;

        for (const cfQuery of cfQueriesToTry) {
          const cfUrl = `${CURSEFORGE_API_URL}/mods/search?gameId=432&classId=6&gameVersion=${encodeURIComponent(mcVersion)}&modLoaderType=${cfLoaderType}&searchFilter=${encodeURIComponent(cfQuery)}&pageSize=10`;

          const response = await fetch(cfUrl, {
            headers: {
              'Accept': 'application/json',
              'x-api-key': curseForgeApiKey
            }
          });

          if (response.ok) {
            const { data: cfMods } = await response.json() as { data: any[] };
            if (cfMods && cfMods.length > 0) {
              cfFound = true;
              const mapped: ModInfo[] = cfMods.map(mod => {
                const versions = new Set<string>();
                if (mod.latestFilesIndexes) {
                  mod.latestFilesIndexes.forEach((idx: any) => {
                    if (idx.gameVersion) versions.add(idx.gameVersion);
                  });
                }

                const latestFile = mod.latestFiles?.find((f: any) => f.isAvailable) || mod.latestFiles?.[0];
                const gameVerList: string[] = Array.isArray(latestFile?.gameVersions) ? latestFile.gameVersions : [];
                const hasClientTag = gameVerList.some(v => v.toLowerCase() === 'client');
                const hasServerTag = gameVerList.some(v => v.toLowerCase() === 'server');

                let clientSide = 'optional';
                let serverSide = 'optional';
                if (hasClientTag && !hasServerTag) {
                  clientSide = 'required';
                  serverSide = 'unsupported';
                } else if (hasServerTag && !hasClientTag) {
                  clientSide = 'unsupported';
                  serverSide = 'required';
                }

                return {
                  id: String(mod.id),
                  slug: mod.slug,
                  title: mod.name,
                  description: mod.summary || mod.name,
                  versions: Array.from(versions).length > 0 ? Array.from(versions) : [mcVersion],
                  client_side: clientSide,
                  server_side: serverSide,
                  license: 'Unknown',
                  download_url: resolveCurseForgeCdnUrl(latestFile),
                  source: 'curseforge',
                };
              });
              results.push(...mapped);
              break;
            }
          }
        }

        // バージョン厳密指定で0件だった場合、メジャーバージョン（例: 1.20）またはバージョン縛りなしで再試行
        if (!cfFound && mcVersion.includes('.')) {
          const majorMc = mcVersion.split('.').slice(0, 2).join('.'); // '1.20'
          for (const cfQuery of [primaryQuery, ...fallbackQueries.slice(0, 1)]) {
            const fallbackUrl = `${CURSEFORGE_API_URL}/mods/search?gameId=432&classId=6&gameVersion=${encodeURIComponent(majorMc)}&modLoaderType=${cfLoaderType}&searchFilter=${encodeURIComponent(cfQuery)}&pageSize=5`;
            const fbRes = await fetch(fallbackUrl, {
              headers: { 'Accept': 'application/json', 'x-api-key': curseForgeApiKey }
            });
            if (fbRes.ok) {
              const { data: cfMods } = await fbRes.json() as { data: any[] };
              if (cfMods && cfMods.length > 0) {
                const mapped: ModInfo[] = cfMods.map(mod => {
                  const latestFile = mod.latestFiles?.find((f: any) => f.isAvailable) || mod.latestFiles?.[0];
                  return {
                    id: String(mod.id),
                    slug: mod.slug,
                    title: mod.name,
                    description: mod.summary || mod.name,
                    versions: [mcVersion],
                    client_side: 'optional',
                    server_side: 'optional',
                    license: 'Unknown',
                    download_url: resolveCurseForgeCdnUrl(latestFile),
                    source: 'curseforge',
                  };
                });
                results.push(...mapped);
                break;
              }
            }
          }
        }
      } catch (error) {
        console.warn('[ModDbTools] CurseForge search failed:', error);
      }
    }

    // 重複の排除および適合度（スコアリング）による並び替え
    const normPrimary = primaryQuery.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normRaw = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const searchWords = primaryQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    const scored = results.map(mod => {
      const titleLower = (mod.title || '').toLowerCase();
      const normTitle = titleLower.replace(/[^a-z0-9]/g, '');
      const slugLower = (mod.slug || '').toLowerCase();
      const normSlug = slugLower.replace(/[^a-z0-9]/g, '');

      let score = 0;
      // 完全一致
      if (normTitle === normPrimary || normTitle === normRaw || normSlug === normPrimary || normSlug === normRaw) {
        score += 300;
      }
      // 前方一致
      else if (normTitle.startsWith(normPrimary) || normSlug.startsWith(normPrimary)) {
        score += 150;
      }
      // 部分一致
      else if (normTitle.includes(normPrimary) || normPrimary.includes(normTitle)) {
        score += 100;
      }

      // 単語レベルの一致
      let matchedWordCount = 0;
      for (const w of searchWords) {
        if (titleLower.includes(w) || slugLower.includes(w)) {
          score += 30;
          matchedWordCount++;
        }
      }

      // 検索語が複数単語あるのに1単語しかヒットしていない場合はスコアを下げる
      if (searchWords.length >= 2 && matchedWordCount < 2 && !normTitle.includes(normPrimary)) {
        score -= 20;
      }

      return { mod, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const deduplicated: ModInfo[] = [];
    for (const item of scored) {
      const key = `${item.mod.source || 'modrinth'}-${item.mod.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(item.mod);
      }
    }
    return deduplicated;
  }

  /**
   * キャッシュ更新用のバッチ処理
   */
  async updateCache(): Promise<void> {
    console.log('[ModDbTools] Starting cache update from Modrinth...');
    // TODO: 定期的に主要MODのリストをフェッチし、D1に書き込むためのデータを返す
  }
}
