const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 830,
    minWidth: 1024,
    minHeight: 768,
    frame: false, // タイトルバー枠を非表示（フレームレス）
    transparent: true, // 背景を透明に（Glassmorphism磨りガラス対応）
    hasShadow: true,
    icon: path.join(__dirname, 'public/images/icon.jpg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Next.js 開発サーバーをロード
  mainWindow.loadURL('http://localhost:3000');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ==========================================
// ウインドウコントロール用の IPC 受信リスナー
// ==========================================
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// ==========================================
// ファイル読み込み用 IPC ハンドラ（Node.js fs 直読み）
// ==========================================
ipcMain.handle('read-file-base64', async (_event, filePath) => {
  try {
    console.log('[Electron Main] Reading file asynchronously (Base64):', filePath);
    const buffer = await fs.promises.readFile(filePath);
    return { success: true, base64: buffer.toString('base64') };
  } catch (err) {
    console.error('[Electron Main] Error reading file (Base64):', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-file-buffer', async (_event, filePath) => {
  try {
    console.log('[Electron Main] Reading file asynchronously (Buffer):', filePath);
    const buffer = await fs.promises.readFile(filePath);
    return { success: true, buffer }; // IPC will serialize this Buffer directly
  } catch (err) {
    console.error('[Electron Main] Error reading file (Buffer):', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('import-modpack', async (_event, filePath, fileName) => {
  try {
    console.log('[Electron Main] Direct filesystem import starting for:', filePath);
    
    // 1. ZIPファイルを非同期で読み込み
    console.log('[Electron Main] Reading file into memory...');
    const buffer = await fs.promises.readFile(filePath);
    
    // 2. JSZip でアーカイブをロード
    console.log('[Electron Main] Loading ZIP archive...');
    const zip = await JSZip.loadAsync(buffer);
    
    const manifestFile = zip.file('manifest.json');
    const modrinthFile = zip.file('modrinth.index.json');
    
    // mods/ フォルダが存在するかチェック（サーバー用パックの誤インポート検出）
    const hasModsFolder = Object.keys(zip.files).some(key => key.startsWith('mods/'));
    
    let manifestData = null;
    let modrinthData = null;
    
    let response;
    if (manifestFile) {
      console.log('[Electron Main] Found CurseForge manifest.json, extracting metadata...');
      const text = await manifestFile.async('text');
      manifestData = JSON.parse(text);
    } else if (modrinthFile) {
      console.log('[Electron Main] Found Modrinth modrinth.index.json, extracting metadata...');
      const text = await modrinthFile.async('text');
      modrinthData = JSON.parse(text);
    } else if (hasModsFolder) {
      console.log('[Electron Main] Detected mods/ folder without manifest.json. Uploading ZIP buffer for JAR metadata scanning...');
      response = await fetch('http://127.0.0.1:8787/api/presets/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(fileName),
          'X-Mock-User-Id': 'dev-user-123',
          'X-Mock-Email': 'dev-user@example.com',
        },
        body: buffer,
      });
    } else {
      throw new Error('サポートされていない形式のMODパックです。ZIPファイル内に manifest.json, modrinth.index.json, または mods/ フォルダが含まれているかご確認ください。');
    }
    
    if (!response) {
      console.log('[Electron Main] Uploading extracted micro-metadata directly to API server...');
      response = await fetch('http://127.0.0.1:8787/api/presets/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mock-User-Id': 'dev-user-123',
          'X-Mock-Email': 'dev-user@example.com',
        },
        body: JSON.stringify({
          fileName,
          manifest: manifestData,
          modrinthIndex: modrinthData,
        }),
      });
    }
    
    const resText = await response.text();
    let resJson;
    try {
      resJson = JSON.parse(resText);
    } catch {}
    
    if (!response.ok) {
      const errorMsg = resJson?.error || resText || 'Unknown API error';
      throw new Error(errorMsg);
    }
    
    console.log('[Electron Main] Import succeeded!');
    return { success: true, data: resJson };
  } catch (err) {
    console.error('[Electron Main] Import failed:', err);
    return { success: false, error: err.message };
  }
});
