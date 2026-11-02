const { execSync } = require('child_process');

const CURSEFORGE_API_KEY = "$2a$10$.PXNAq5iFwwWT5KmmhgeHOvBPov4gwJ1uX.qPfsRz9g4I2aPz0fPm";
const CURSEFORGE_API_URL = 'https://api.curseforge.com/v1';

async function run() {
  console.log("=== MOD URL Fixer ===");

  // 1. D1ローカルDBからMOD一覧を取得する
  const cmd = `npx wrangler d1 execute DB --local --command "SELECT m.id, m.name, m.external_id, m.download_url, m.mc_version, m.loader FROM preset_mods pm JOIN mods m ON pm.mod_id = m.id WHERE pm.preset_id = (SELECT preset_id FROM server_sessions WHERE stopped_at IS NULL LIMIT 1) AND m.source = 'curseforge';"`;
  console.log("Fetching CurseForge mods from local database...");
  
  let modsOutput;
  try {
    modsOutput = execSync(cmd, { cwd: 'apps/api' }).toString();
  } catch (err) {
    console.error("Failed to execute D1 command:", err.message);
    return;
  }

  // D1コマンド出力からJSON部分を抽出する
  const jsonStart = modsOutput.indexOf('[');
  const jsonEnd = modsOutput.lastIndexOf(']') + 1;
  if (jsonStart === -1 || jsonEnd === 0) {
    console.error("Could not parse D1 JSON output. Output was:", modsOutput);
    return;
  }

  const outputData = JSON.parse(modsOutput.substring(jsonStart, jsonEnd));
  const mods = outputData[0]?.results || [];
  console.log(`Found ${mods.length} CurseForge mods to inspect.`);

  for (const mod of mods) {
    const modId = Number(mod.external_id);
    if (isNaN(modId)) {
      console.log(`Skipping ${mod.name} (invalid external_id: ${mod.external_id})`);
      continue;
    }

    console.log(`\nInspecting mod: ${mod.name} (CurseForge ID: ${modId})...`);
    console.log(`Current URL: ${mod.download_url}`);

    try {
      // CurseForge API でファイル一覧を取得する
      const res = await fetch(`${CURSEFORGE_API_URL}/mods/${modId}/files`, {
        headers: {
          'Accept': 'application/json',
          'x-api-key': CURSEFORGE_API_KEY
        }
      });

      if (!res.ok) {
        console.warn(`CurseForge API returned status ${res.status} for mod ${modId}`);
        continue;
      }

      const { data: files } = await res.json();
      if (!files || files.length === 0) {
        console.warn(`No files found for mod ${modId}`);
        continue;
      }

      // 1.20.1 かつ Forge 対応のファイルを検索する
      // バージョンが「1.20.1」であり、かつ「forge」という文言がgameVersionsに含まれているものを探す
      const targetFile = files.find(f => {
        const hasMc = f.gameVersions?.includes('1.20.1');
        const hasLoader = f.gameVersions?.some(v => 
          v.toLowerCase() === 'forge' || v.toLowerCase() === 'any'
        );
        return hasMc && hasLoader && f.isAvailable;
      });

      if (targetFile) {
        const newUrl = targetFile.downloadUrl;
        const newName = targetFile.fileName;
        console.log(`FOUND 1.20.1 Forge compatible file: ${newName}`);
        console.log(`New URL: ${newUrl}`);

        if (newUrl && newUrl !== mod.download_url) {
          // DBの download_url と name を更新する
          // SQL injectionを防ぐためにエスケープ処理か安全なUPDATEコマンドを組み立てる
          const escapedUrl = newUrl.replace(/'/g, "''");
          const escapedName = newName.replace(/'/g, "''");
          const updateCmd = `npx wrangler d1 execute DB --local --command "UPDATE mods SET download_url = '${escapedUrl}', name = '${escapedName}' WHERE id = '${mod.id}';"`;
          console.log(`Updating database for ${mod.name}...`);
          execSync(updateCmd, { cwd: 'apps/api' });
          console.log("Update successful!");
        } else if (!newUrl) {
          console.log("No download URL available in metadata.");
        } else {
          console.log("URL is already up-to-date.");
        }
      } else {
        console.warn(`Could not find a 1.20.1 Forge compatible file for ${mod.name}. Checked game versions for each file.`);
        // 最新のファイルをフォールバックにするか検討
        const latestFile = files[0];
        console.log(`Latest available file: ${latestFile?.fileName} (game versions: ${latestFile?.gameVersions?.join(', ')})`);
      }

    } catch (err) {
      console.error(`Error checking files for ${mod.name}:`, err.message);
    }
  }

  console.log("\nFinished URL updates!");
}

run();
