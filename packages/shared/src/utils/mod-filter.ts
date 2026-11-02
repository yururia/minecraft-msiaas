import JSZip from 'jszip';

export type ModSide = 'client' | 'server' | 'both' | 'unknown';

export interface ModDependency {
  modId: string;
  versionRange: string;
  mandatory: boolean;
  side: 'CLIENT' | 'SERVER' | 'BOTH';
}

export interface MissingDependencyInfo {
  requiredModId: string;
  versionRange: string;
  requiredByModName: string;
  requiredByModId: string;
  targetSide: 'server' | 'client' | 'both';
}

export interface CompatibilityReport {
  isServerReady: boolean;
  isClientReady: boolean;
  missingServerDeps: MissingDependencyInfo[];
  missingClientDeps: MissingDependencyInfo[];
  requiredClientMods: Array<{
    modId: string;
    name: string;
    version: string;
    fileName: string;
    side: ModSide;
    reason: string;
  }>;
}

export interface ScannedMod {
  fileName: string;
  modId: string;
  name: string;
  version: string;
  loader: 'forge' | 'fabric' | 'neoforge' | 'quilt' | 'unknown';
  detectedSide: ModSide;
  side: 'server' | 'client_only' | 'unknown';
  rawMetadata: any;
  explanation?: string;
  reason: string;
  dependencies?: ModDependency[];
  provides?: string[];
}

export interface ModClassificationResult {
  server: ScannedMod[];      // safe for server (both/server)
  clientOnly: ScannedMod[];  // client-only (client)
  client_only: ScannedMod[]; // snake_case alias for clientOnly
  unknown: ScannedMod[];     // unknown side / unidentifiable
  all: ScannedMod[];         // all scanned mods
  compatibility: CompatibilityReport;
}

export type ModScanResult = ModClassificationResult;

const BUILTIN_MOD_IDS = new Set([
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fml',
  'fabricloader',
  'fabric-loader',
  'fabric_loader',
  'asmfabricloader',
  'asm-fabric-loader',
  'asm_fabric_loader',
  'quilt_loader',
  'quilt-loader',
  'mixinextras',
  'spongemixin',
  'sponge_mixin',
  'optifine',
]);

/**
 * Simple line-by-line TOML parser for mods.toml
 * Forge mods.toml files are typically simple, so a basic parser is sufficient.
 */
export function parseSimpleTOML(content: string): any {
  const result: any = {};
  let currentTable: any = null;

  // Strip multi-line literal/basic strings ('''...''' and """...""") so embedded [...] or key=val lines don't corrupt table state
  const cleanedContent = content
    .replace(/'''[\s\S]*?'''/g, '""')
    .replace(/"""[\s\S]*?"""/g, '""');

  const lines = cleanedContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip trailing comments on table headers e.g. [[dependencies.modid]] #optional
    const headerCandidate = trimmed.replace(/#.*$/, '').trim();

    // Check for array of tables or standard tables, e.g. [[dependencies.modid]] or [mods]
    if (headerCandidate.startsWith('[') && headerCandidate.endsWith(']')) {
      const isArrayTable = headerCandidate.startsWith('[[') && headerCandidate.endsWith(']]');
      const name = isArrayTable 
        ? headerCandidate.slice(2, -2).trim() 
        : headerCandidate.slice(1, -1).trim();

      if (isArrayTable) {
        const parts = name.split('.');
        let parent = result;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].replace(/^["']|["']$/g, '').trim();
          if (i === parts.length - 1) {
            if (!parent[part]) parent[part] = [];
            const newTable = {};
            parent[part].push(newTable);
            currentTable = newTable;
          } else {
            if (!parent[part]) parent[part] = {};
            parent = parent[part];
          }
        }
      } else {
        const parts = name.split('.');
        let parent = result;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].replace(/^["']|["']$/g, '').trim();
          if (i === parts.length - 1) {
            if (!parent[part]) parent[part] = {};
            currentTable = parent[part];
          } else {
            if (!parent[part]) parent[part] = {};
            parent = parent[part];
          }
        }
      }
      continue;
    }

    // Key-value pairs
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim().replace(/^["']|["']$/g, '');
      let valStr = trimmed.slice(eqIndex + 1).trim();

      const target = currentTable || result;
      if (valStr.startsWith('"')) {
        // Extract up to matching unescaped double quote, ignoring any trailing #comment
        let endIdx = -1;
        for (let i = 1; i < valStr.length; i++) {
          if (valStr[i] === '"' && valStr[i - 1] !== '\\') {
            endIdx = i;
            break;
          }
        }
        const extracted = endIdx >= 1 ? valStr.slice(1, endIdx) : valStr.slice(1);
        target[key] = extracted.replace(/\\"/g, '"');
      } else if (valStr.startsWith("'")) {
        const endIdx = valStr.indexOf("'", 1);
        const extracted = endIdx >= 1 ? valStr.slice(1, endIdx) : valStr.slice(1);
        target[key] = extracted;
      } else {
        const hashIdx = valStr.indexOf('#');
        if (hashIdx >= 0) {
          valStr = valStr.slice(0, hashIdx).trim();
        }
        const lowerVal = valStr.toLowerCase();
        if (lowerVal === 'true') {
          target[key] = true;
        } else if (lowerVal === 'false') {
          target[key] = false;
        } else {
          target[key] = valStr;
        }
      }
    }
  }

  return result;
}

function buildScannedMod(
  base: Omit<ScannedMod, 'side' | 'reason'>
): ScannedMod {
  const side: 'server' | 'client_only' | 'unknown' =
    base.detectedSide === 'client'
      ? 'client_only'
      : base.detectedSide === 'unknown'
        ? 'unknown'
        : 'server';
  return {
    ...base,
    side,
    reason: base.explanation || '',
    dependencies: base.dependencies || [],
    provides: base.provides || [],
  };
}

/**
 * Classify the side of a MOD and extract its dependencies using its metadata contents.
 */
export function classifyModSide(
  fileName: string,
  metadata: {
    fabricJson?: any;
    quiltJson?: any;
    modsToml?: any;
    bundledJarIds?: string[];
    manifestText?: string;
    hasModLauncherServices?: boolean;
  }
): ScannedMod {
  const {
    fabricJson,
    quiltJson,
    modsToml,
    bundledJarIds = [],
    manifestText = '',
    hasModLauncherServices = false,
  } = metadata;

  // 1. Fabric Check (only when modsToml is not present, so dual-loader Forge+Fabric JARs use Forge metadata when mods.toml exists)
  if (fabricJson && !modsToml) {
    const modId = String(fabricJson.id || 'unknown');
    const name = String(fabricJson.name || modId);
    const version = String(fabricJson.version || '0.0.0');
    const env = fabricJson.environment;

    const provides: string[] = [...bundledJarIds];
    if (Array.isArray(fabricJson.provides)) {
      for (const p of fabricJson.provides) {
        if (typeof p === 'string') provides.push(p);
      }
    }
    if (Array.isArray(fabricJson.jars)) {
      for (const j of fabricJson.jars) {
        if (j?.file) {
          const base = String(j.file).split('/').pop()?.replace(/\.jar$/i, '') || '';
          if (base) provides.push(base);
        }
      }
    }

    const dependencies: ModDependency[] = [];
    const targetSide: 'CLIENT' | 'SERVER' | 'BOTH' =
      env === 'client'
        ? 'CLIENT'
        : env === 'server' || env === 'dedicated_server'
          ? 'SERVER'
          : 'BOTH';

    if (fabricJson.depends && typeof fabricJson.depends === 'object') {
      for (const [depId, verRange] of Object.entries(fabricJson.depends)) {
        dependencies.push({
          modId: depId,
          versionRange: Array.isArray(verRange) ? verRange.join(' || ') : String(verRange || '*'),
          mandatory: true,
          side: targetSide,
        });
      }
    }

    if (env === 'client') {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'fabric',
        detectedSide: 'client',
        rawMetadata: fabricJson,
        explanation: `fabric.mod.json environment is 'client'`,
        dependencies,
        provides,
      });
    } else if (env === 'server' || env === 'dedicated_server') {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'fabric',
        detectedSide: 'server',
        rawMetadata: fabricJson,
        explanation: `fabric.mod.json environment is '${env}'`,
        dependencies,
        provides,
      });
    } else {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'fabric',
        detectedSide: 'both',
        rawMetadata: fabricJson,
        explanation: `fabric.mod.json environment is '*' (or unspecified, defaulting to both)`,
        dependencies,
        provides,
      });
    }
  }

  // 2. Quilt Check (only when modsToml is not present)
  if (quiltJson && !modsToml) {
    const loaderBlock = quiltJson.quilt_loader || {};
    const modId = String(loaderBlock.id || quiltJson.id || 'unknown');
    const metadataBlock = loaderBlock.metadata || {};
    const name = String(metadataBlock.name || quiltJson.name || modId);
    const version = String(loaderBlock.version || quiltJson.version || '0.0.0');
    const env = quiltJson.environment || loaderBlock.environment || quiltJson.minecraft?.environment;

    const provides: string[] = [...bundledJarIds];
    if (Array.isArray(loaderBlock.provides)) {
      for (const p of loaderBlock.provides) {
        if (typeof p === 'string') provides.push(p);
        else if (p?.id) provides.push(String(p.id));
      }
    }

    const targetSide: 'CLIENT' | 'SERVER' | 'BOTH' =
      env === 'client'
        ? 'CLIENT'
        : env === 'server' || env === 'dedicated_server'
          ? 'SERVER'
          : 'BOTH';

    const dependencies: ModDependency[] = [];
    if (Array.isArray(loaderBlock.depends)) {
      for (const dep of loaderBlock.depends) {
        if (typeof dep === 'string') {
          dependencies.push({
            modId: dep,
            versionRange: '*',
            mandatory: true,
            side: targetSide,
          });
        } else if (dep && typeof dep === 'object' && dep.id) {
          const isOptional = dep.optional === true;
          if (!isOptional) {
            dependencies.push({
              modId: String(dep.id),
              versionRange: String(dep.versions || '*'),
              mandatory: true,
              side: targetSide,
            });
          }
        }
      }
    }

    if (env === 'client') {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'quilt',
        detectedSide: 'client',
        rawMetadata: quiltJson,
        explanation: `quilt.mod.json environment is 'client'`,
        dependencies,
        provides,
      });
    } else if (env === 'server' || env === 'dedicated_server') {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'quilt',
        detectedSide: 'server',
        rawMetadata: quiltJson,
        explanation: `quilt.mod.json environment is '${env}'`,
        dependencies,
        provides,
      });
    } else {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader: 'quilt',
        detectedSide: 'both',
        rawMetadata: quiltJson,
        explanation: `quilt.mod.json environment is '*' (or unspecified, defaulting to both)`,
        dependencies,
        provides,
      });
    }
  }

  // 3. Forge / NeoForge Check
  if (modsToml) {
    const modsList = Array.isArray(modsToml.mods) ? modsToml.mods : [];
    const firstMod = modsList[0] || {};
    const modId = String(firstMod.modId || 'unknown');
    const name = String(firstMod.displayName || firstMod.name || modId);
    const version = String(firstMod.version || '0.0.0');

    const provides: string[] = [...bundledJarIds];
    for (let i = 1; i < modsList.length; i++) {
      if (modsList[i]?.modId) provides.push(String(modsList[i].modId));
    }
    if (fabricJson?.id) {
      provides.push(String(fabricJson.id));
    }
    if (quiltJson?.quilt_loader?.id) {
      provides.push(String(quiltJson.quilt_loader.id));
    }
    if (modsToml.languageLoader) {
      provides.push(String(modsToml.languageLoader));
    }

    const dependenciesMap = modsToml.dependencies || {};
    let clientOnlyDetected = false;
    let explanation = '';
    const dependencies: ModDependency[] = [];

    for (const key of Object.keys(dependenciesMap)) {
      const depList = dependenciesMap[key];
      if (Array.isArray(depList)) {
        for (const dep of depList) {
          const depModId = String(dep.modId || '').trim();
          const depModIdLower = depModId.toLowerCase();
          const sideRaw = String(dep.side || 'BOTH').toUpperCase();
          const depSide: 'CLIENT' | 'SERVER' | 'BOTH' =
            sideRaw === 'CLIENT' ? 'CLIENT' : sideRaw === 'SERVER' ? 'SERVER' : 'BOTH';
          const mandatory =
            dep.mandatory !== undefined
              ? dep.mandatory === true || String(dep.mandatory).toLowerCase() === 'true'
              : String(dep.type || '').toLowerCase() === 'required';

          if (
            (depModIdLower === 'minecraft' || depModIdLower === 'forge' || depModIdLower === 'neoforge') &&
            depSide === 'CLIENT'
          ) {
            clientOnlyDetected = true;
            explanation = `mods.toml has dependency on '${depModIdLower}' with side = 'CLIENT'`;
          }

          if (depModId) {
            dependencies.push({
              modId: depModId,
              versionRange: String(dep.versionRange || '*'),
              mandatory,
              side: depSide,
            });
          }
        }
      }
    }

    const loader = fileName.toLowerCase().includes('neoforge') || JSON.stringify(modsToml).toLowerCase().includes('neoforge')
      ? 'neoforge'
      : 'forge';

    if (clientOnlyDetected) {
      return buildScannedMod({
        fileName,
        modId,
        name,
        version,
        loader,
        detectedSide: 'client',
        rawMetadata: modsToml,
        explanation,
        dependencies,
        provides,
      });
    }

    return buildScannedMod({
      fileName,
      modId,
      name,
      version,
      loader,
      detectedSide: 'both',
      rawMetadata: modsToml,
      explanation: `mods.toml parsed without CLIENT-only dependency side constraints`,
      dependencies,
      provides,
    });
  }

  // 4. Forge / ModLauncher CoreMod, GameLibrary, or LanguageProvider (MANIFEST.MF with FMLModType, Automatic-Module-Name, META-INF/services, or Jar-in-Jar container)
  if (
    hasModLauncherServices ||
    bundledJarIds.length > 0 ||
    /FMLModType\s*:/i.test(manifestText) ||
    /Automatic-Module-Name\s*:/i.test(manifestText)
  ) {
    const autoModMatch = manifestText.match(/Automatic-Module-Name\s*:\s*([^\r\n]+)/i);
    const specTitleMatch = manifestText.match(/Specification-Title\s*:\s*([^\r\n]+)/i);
    const implVerMatch = manifestText.match(/Implementation-Version\s*:\s*([^\r\n]+)/i);
    const baseFileStem = fileName
      .split('/')
      .pop()!
      .replace(/\.jar$/i, '')
      .split(/[-_]\d/)[0]
      .replace(/[-_](all|forge|lexforge|core|mod)$/gi, '');

    const derivedId = autoModMatch
      ? autoModMatch[1].trim().split('.').pop()!
      : specTitleMatch
        ? specTitleMatch[1].trim()
        : bundledJarIds[0] || baseFileStem;

    const provides = Array.from(new Set([...bundledJarIds, baseFileStem, derivedId]));
    return buildScannedMod({
      fileName,
      modId: derivedId,
      name: baseFileStem || derivedId,
      version: implVerMatch ? implVerMatch[1].trim() : '1.0.0',
      loader: 'forge',
      detectedSide: 'both',
      rawMetadata: { manifestText, bundledJarIds },
      explanation: `Forge Library / TransformationService / Jar-in-Jar container`,
      dependencies: [],
      provides,
    });
  }

  // 5. Default to Unknown
  return buildScannedMod({
    fileName,
    modId: 'unknown',
    name: fileName.replace(/\.jar$/i, ''),
    version: 'unknown',
    loader: 'unknown',
    detectedSide: 'unknown',
    rawMetadata: null,
    explanation: `No metadata files (fabric.mod.json, quilt.mod.json, META-INF/mods.toml) found`,
    dependencies: [],
    provides: bundledJarIds,
  });
}

/**
 * Verify server and client dependency compatibility across a set of scanned mods.
 * Identifies missing server dependencies, missing client dependencies (e.g. client prerequisites not included in a server pack ZIP),
 * and the complete list of mods required on the client to join the server.
 */
export function verifyServerAndClientCompatibility(
  scannedMods: ScannedMod[]
): CompatibilityReport {
  const serverAvailableIds = new Set<string>();
  const clientAvailableIds = new Set<string>();

  for (const mod of scannedMods) {
    const idLower = mod.modId.toLowerCase();
    const allProvided = [idLower, ...(mod.provides || []).map(p => p.toLowerCase())];

    if (mod.detectedSide === 'server' || mod.detectedSide === 'both') {
      for (const pid of allProvided) serverAvailableIds.add(pid);
    }
    if (mod.detectedSide === 'client' || mod.detectedSide === 'both') {
      for (const pid of allProvided) clientAvailableIds.add(pid);
    }
  }

  const hasFabricApiOnServer = serverAvailableIds.has('fabric-api') || serverAvailableIds.has('fabric') || serverAvailableIds.has('quilted_fabric_api');
  const hasFabricApiOnClient = clientAvailableIds.has('fabric-api') || clientAvailableIds.has('fabric') || clientAvailableIds.has('quilted_fabric_api');

  const isSatisfied = (depIdRaw: string, availableSet: Set<string>, hasFabricApi: boolean): boolean => {
    const depId = depIdRaw.toLowerCase();
    if (BUILTIN_MOD_IDS.has(depId)) return true;
    if (availableSet.has(depId)) return true;
    const normalized = depId.replace(/-/g, '_');
    const hyphenated = depId.replace(/_/g, '-');
    if (availableSet.has(normalized) || availableSet.has(hyphenated)) return true;
    if (hasFabricApi && (depId.startsWith('fabric-') || depId.startsWith('fabric_'))) {
      return true;
    }
    return false;
  };

  const missingServerDeps: MissingDependencyInfo[] = [];
  const missingClientDeps: MissingDependencyInfo[] = [];
  const seenServerMissing = new Set<string>();
  const seenClientMissing = new Set<string>();

  for (const mod of scannedMods) {
    if (!mod.dependencies) continue;

    const runsOnServer = mod.detectedSide === 'server' || mod.detectedSide === 'both';
    const runsOnClient = mod.detectedSide === 'client' || mod.detectedSide === 'both';

    for (const dep of mod.dependencies) {
      if (!dep.mandatory) continue;

      // Check Server-side requirement
      if (runsOnServer && (dep.side === 'SERVER' || dep.side === 'BOTH')) {
        if (!isSatisfied(dep.modId, serverAvailableIds, hasFabricApiOnServer)) {
          const key = `${dep.modId.toLowerCase()}::${mod.modId.toLowerCase()}`;
          if (!seenServerMissing.has(key)) {
            seenServerMissing.add(key);
            missingServerDeps.push({
              requiredModId: dep.modId,
              versionRange: dep.versionRange,
              requiredByModName: mod.name,
              requiredByModId: mod.modId,
              targetSide: dep.side === 'SERVER' ? 'server' : 'both',
            });
          }
        }
      }

      // Check Client-side requirement (including CLIENT-only dependencies required by BOTH/SERVER mods when joining from a client!)
      if (runsOnClient && (dep.side === 'CLIENT' || dep.side === 'BOTH')) {
        if (!isSatisfied(dep.modId, clientAvailableIds, hasFabricApiOnClient)) {
          const key = `${dep.modId.toLowerCase()}::${mod.modId.toLowerCase()}`;
          if (!seenClientMissing.has(key)) {
            seenClientMissing.add(key);
            missingClientDeps.push({
              requiredModId: dep.modId,
              versionRange: dep.versionRange,
              requiredByModName: mod.name,
              requiredByModId: mod.modId,
              targetSide: dep.side === 'CLIENT' ? 'client' : 'both',
            });
          }
        }
      }
    }
  }

  const requiredClientMods = scannedMods
    .filter(m => m.detectedSide === 'both' || m.detectedSide === 'client')
    .map(m => ({
      modId: m.modId,
      name: m.name,
      version: m.version,
      fileName: m.fileName,
      side: m.detectedSide,
      reason:
        m.detectedSide === 'both'
          ? 'サーバー・クライアント共通MOD（サーバー入室に必須）'
          : 'クライアント専用MOD（描画・UI・クライアント補助）',
    }));

  return {
    isServerReady: missingServerDeps.length === 0,
    isClientReady: missingClientDeps.length === 0,
    missingServerDeps,
    missingClientDeps,
    requiredClientMods,
  };
}

export interface ModScanProgress {
  current: number;
  total: number;
  currentFile: string;
  percent: number;
}

/**
 * Scan a ZIP file (as buffer) and classify/filter mods inside it,
 * including bidirectional server & client dependency verification.
 * Yields periodically to the JavaScript event loop to keep the UI completely responsive.
 */
export async function scanAndFilterMods(
  zipData: ArrayBuffer | Uint8Array,
  onProgress?: (progress: ModScanProgress) => void
): Promise<ModClassificationResult> {
  const clientOnlyList: ScannedMod[] = [];
  const result: ModClassificationResult = {
    server: [],
    clientOnly: clientOnlyList,
    client_only: clientOnlyList,
    unknown: [],
    all: [],
    compatibility: {
      isServerReady: true,
      isClientReady: true,
      missingServerDeps: [],
      missingClientDeps: [],
      requiredClientMods: [],
    },
  };

  const zip = await JSZip.loadAsync(zipData);
  const modFiles: JSZip.JSZipObject[] = [];

  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.toLowerCase().endsWith('.jar')) {
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const parts = normalizedPath.split('/');
      if (parts.includes('mods') || normalizedPath.startsWith('mods/')) {
        modFiles.push(file);
      }
    }
  });

  const total = modFiles.length;
  if (onProgress) {
    onProgress({ current: 0, total, currentFile: 'MODアーカイブをスキャン開始...', percent: 0 });
  }

  for (let i = 0; i < total; i++) {
    const file = modFiles[i];

    // 分割読み込み（3件ごとにイベントループへ制御を戻し、UIの完全な描画・応答性を維持）
    if (i % 3 === 0) {
      if (onProgress) {
        onProgress({
          current: i,
          total,
          currentFile: file.name,
          percent: total > 0 ? Math.round((i / total) * 100) : 0,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      const jarBuffer = await file.async('uint8array');
      const jarZip = await JSZip.loadAsync(jarBuffer);

      let fabricJson: any = null;
      let quiltJson: any = null;
      let modsToml: any = null;
      let manifestText = '';
      let hasModLauncherServices = false;
      const bundledJarIds: string[] = [];

      const manifestFile = jarZip.file('META-INF/MANIFEST.MF');
      if (manifestFile) {
        try {
          manifestText = await manifestFile.async('string');
        } catch {}
      }

      jarZip.forEach((entryPath, entryObj) => {
        if (!entryObj.dir && entryPath.startsWith('META-INF/services/')) {
          hasModLauncherServices = true;
        }
      });

      // Detect bundled Jar-in-Jar files (META-INF/jars/*.jar or META-INF/jarjar/metadata.json)
      const jarJarMetaFile = jarZip.file('META-INF/jarjar/metadata.json');
      if (jarJarMetaFile) {
        try {
          const jarJarMeta = JSON.parse(await jarJarMetaFile.async('string'));
          if (Array.isArray(jarJarMeta?.jars)) {
            for (const j of jarJarMeta.jars) {
              if (j?.identifier?.artifact) {
                bundledJarIds.push(String(j.identifier.artifact));
              }
            }
          }
        } catch {}
      }

      // Also scan nested JARs in META-INF/jarjar/ or META-INF/jars/ for their actual modId
      const nestedJarEntries: JSZip.JSZipObject[] = [];
      jarZip.forEach((nestedPath, nestedEntry) => {
        if (
          !nestedEntry.dir &&
          nestedPath.toLowerCase().endsWith('.jar') &&
          (nestedPath.startsWith('META-INF/jarjar/') || nestedPath.startsWith('META-INF/jars/'))
        ) {
          nestedJarEntries.push(nestedEntry);
        }
      });
      for (const nestedEntry of nestedJarEntries) {
        try {
          const nestedBuf = await nestedEntry.async('uint8array');
          const nestedZip = await JSZip.loadAsync(nestedBuf);
          const nestedTomlFile = nestedZip.file('META-INF/mods.toml') || nestedZip.file('META-INF/neoforge.mods.toml');
          if (nestedTomlFile) {
            const nestedToml = parseSimpleTOML(await nestedTomlFile.async('string'));
            if (Array.isArray(nestedToml?.mods)) {
              for (const nm of nestedToml.mods) {
                if (nm?.modId) bundledJarIds.push(String(nm.modId));
              }
            }
          }
          const nestedFabricFile = nestedZip.file('fabric.mod.json');
          if (nestedFabricFile) {
            const nestedFab = JSON.parse(await nestedFabricFile.async('string'));
            if (nestedFab?.id) bundledJarIds.push(String(nestedFab.id));
          }
        } catch {}
      }

      const fabricFile = jarZip.file('fabric.mod.json');
      if (fabricFile) {
        const text = await fabricFile.async('string');
        try {
          fabricJson = JSON.parse(text);
        } catch (e) {
          console.warn(`Failed to parse fabric.mod.json in ${file.name}:`, e);
        }
      }

      const quiltFile = jarZip.file('quilt.mod.json');
      if (quiltFile) {
        const text = await quiltFile.async('string');
        try {
          quiltJson = JSON.parse(text);
        } catch (e) {
          console.warn(`Failed to parse quilt.mod.json in ${file.name}:`, e);
        }
      }

      const tomlFile = jarZip.file('META-INF/mods.toml') || jarZip.file('META-INF/neoforge.mods.toml');
      if (tomlFile) {
        const text = await tomlFile.async('string');
        try {
          modsToml = parseSimpleTOML(text);
        } catch (e) {
          console.warn(`Failed to parse META-INF/mods.toml in ${file.name}:`, e);
        }
      }

      const scanned = classifyModSide(file.name, {
        fabricJson,
        quiltJson,
        modsToml,
        bundledJarIds,
        manifestText,
        hasModLauncherServices,
      });

      result.all.push(scanned);
      if (scanned.detectedSide === 'client') {
        result.clientOnly.push(scanned);
      } else if (scanned.detectedSide === 'unknown') {
        result.unknown.push(scanned);
      } else {
        result.server.push(scanned);
      }
    } catch (error) {
      console.error(`Failed to scan jar file: ${file.name}`, error);
      const fallbackMod = buildScannedMod({
        fileName: file.name,
        modId: 'unknown',
        name: file.name.replace(/\.jar$/i, ''),
        version: 'unknown',
        loader: 'unknown',
        detectedSide: 'unknown',
        rawMetadata: null,
        explanation: `Failed to open or read JAR file: ${error instanceof Error ? error.message : String(error)}`,
      });
      result.all.push(fallbackMod);
      result.unknown.push(fallbackMod);
    }
  }

  // Promote any mod initially marked 'client' (due to a quirk in its mods.toml like Supplementaries having side='CLIENT' on minecraft)
  // if another server/both mod in the pack explicitly depends on it on SERVER or BOTH sides.
  const requiredOnServerByOthers = new Set<string>();
  for (const mod of result.all) {
    if (mod.detectedSide === 'server' || mod.detectedSide === 'both') {
      for (const dep of mod.dependencies || []) {
        if (dep.side === 'SERVER' || dep.side === 'BOTH') {
          requiredOnServerByOthers.add(dep.modId.toLowerCase());
        }
      }
    }
  }
  for (let i = result.clientOnly.length - 1; i >= 0; i--) {
    const cliMod = result.clientOnly[i];
    if (requiredOnServerByOthers.has(cliMod.modId.toLowerCase())) {
      cliMod.detectedSide = 'both';
      cliMod.side = 'server';
      cliMod.explanation = `Promoted to BOTH because server mods depend on '${cliMod.modId}'`;
      cliMod.reason = cliMod.explanation;
      result.clientOnly.splice(i, 1);
      result.server.push(cliMod);
    }
  }

  result.compatibility = verifyServerAndClientCompatibility(result.all);
  if (onProgress) {
    onProgress({ current: total, total, currentFile: '解析完了', percent: 100 });
  }
  return result;
}
