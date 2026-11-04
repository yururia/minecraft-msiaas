const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

let mainWindow;

const MAX_MODPACK_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB upper limit
const ALLOWED_EXTENSIONS = new Set(['.zip', '.mrpack', '.jar', '.json', '.toml']);

/**
 * Validates that a requested file path is safe, has an allowed extension,
 * does not contain null bytes or sensitive system directory targets,
 * and stays within the size limit.
 */
async function validateSafeFileAccess(filePath, allowedExts = ALLOWED_EXTENSIONS) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new Error('Invalid file path specified.');
  }

  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();

  if (!allowedExts.has(ext)) {
    throw new Error(`Unsupported or forbidden file extension: ${ext}`);
  }

  // Block sensitive OS and credential directories
  const normalizedLower = resolvedPath.replace(/\\/g, '/').toLowerCase();
  const forbiddenSegments = ['/.ssh/', '/.aws/', '/.oci/', '/etc/shadow', '/etc/passwd', '/windows/system32/config'];
  if (forbiddenSegments.some((seg) => normalizedLower.includes(seg))) {
    throw new Error('Access to sensitive system or credential directories is forbidden.');
  }

  const stat = await fs.promises.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error('Target path is not a regular file.');
  }
  if (stat.size > MAX_MODPACK_SIZE_BYTES) {
    throw new Error(`File exceeds maximum allowed size (${MAX_MODPACK_SIZE_BYTES} bytes).`);
  }

  return resolvedPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 830,
    minWidth: 1024,
    minHeight: 768,
    frame: false,
    transparent: true,
    hasShadow: true,
    icon: path.join(__dirname, 'public/images/icon.jpg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

ipcMain.handle('read-file-base64', async (_event, filePath) => {
  try {
    const safePath = await validateSafeFileAccess(filePath);
    const buffer = await fs.promises.readFile(safePath);
    return { success: true, base64: buffer.toString('base64') };
  } catch (err) {
    console.error('[Electron Main] Error reading file (Base64):', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-file-buffer', async (_event, filePath) => {
  try {
    const safePath = await validateSafeFileAccess(filePath);
    const buffer = await fs.promises.readFile(safePath);
    return { success: true, buffer };
  } catch (err) {
    console.error('[Electron Main] Error reading file (Buffer):', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('import-modpack', async (_event, filePath, fileName) => {
  try {
    const safePath = await validateSafeFileAccess(filePath, new Set(['.zip', '.mrpack']));
    const buffer = await fs.promises.readFile(safePath);
    const zip = await JSZip.loadAsync(buffer);

    const manifestFile = zip.file('manifest.json');
    const modrinthFile = zip.file('modrinth.index.json');
    const hasModsFolder = Object.keys(zip.files).some((key) => key.startsWith('mods/') && !key.includes('..'));

    let manifestData = null;
    let modrinthData = null;
    let response;

    if (manifestFile) {
      const text = await manifestFile.async('text');
      manifestData = JSON.parse(text);
    } else if (modrinthFile) {
      const text = await modrinthFile.async('text');
      modrinthData = JSON.parse(text);
    } else if (hasModsFolder) {
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
      throw new Error('サポートされていない形式のMODパックです。ZIPファイル内に manifest.json, modrinth.index.json, または mods/ フォルダが必要です。');
    }

    if (!response) {
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

    return { success: true, data: resJson };
  } catch (err) {
    console.error('[Electron Main] Import failed:', err);
    return { success: false, error: err.message };
  }
});

module.exports = { validateSafeFileAccess };
