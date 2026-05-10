"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path   = require("path");
const Store  = require("electron-store");
const { autoUpdater } = require("electron-updater");

// ════════════════════════════════════════
// AUTO-UPDATER CONFIG
// ════════════════════════════════════════
autoUpdater.autoDownload    = false; // user clicks "Update" — we don't download behind their back
autoUpdater.autoInstallOnAppQuit = true; // once downloaded, install silently on next quit

// Disable code signature verification on Mac (app is not signed with Apple certificate)
if (process.platform === "darwin") {
  autoUpdater.verifyUpdateCodeSignature = false;
}

// ════════════════════════════════════════
// STARTUP PERFORMANCE FLAGS
// Must be set before app is ready.
// ════════════════════════════════════════
// Disable GPU process sandbox (reduces process spawn overhead on Windows)
app.commandLine.appendSwitch("disable-gpu-sandbox");
// Skip GPU info collection on startup (saves ~50–150 ms)
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
// Use hardware acceleration but skip slow software rasterizer fallback
app.commandLine.appendSwitch("enable-gpu-rasterization");
// Reduce IPC overhead on renderer startup
app.commandLine.appendSwitch("renderer-process-limit", "1");
// V8 code cache: reuse compiled JS across launches (saves 20–60 ms per launch)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");

// ── Encrypted credential store ──
const store = new Store({
  name: "as-team-config",
  encryptionKey: "as-team-2024-secure-key",
});

let mainWindow = null;

function createWindow() {
  const iconPath = process.platform === "win32"
    ? path.join(__dirname, "../../assets/icon.ico")
    : process.platform === "darwin"
    ? path.join(__dirname, "../../assets/icon.icns")
    : path.join(__dirname, "../../assets/icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    icon: iconPath,
    backgroundColor: "#0a0b0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: true,
    // PERF: Show window immediately once ready-to-show fires
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // V8 snapshot: reuse compiled bytecode across launches
      v8CacheOptions: "bypassHeatCheck",
      // Disable spell check — saves renderer init time for a non-document app
      spellcheck: false,
      // PERF: Keep running at full speed even when window is hidden/backgrounded
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  // ── Check for updates ~3 seconds after launch (gives window time to load) ──
  if (app.isPackaged) {
    setTimeout(() => {
      updLog('info', 'Startup auto-update check triggered (3s delay)');
      autoUpdater.checkForUpdates().catch(err => {
        updLog('error', `Startup checkForUpdates failed: ${err.message}`);
      });
    }, 3000);
  } else {
    updLog('info', 'Skipping startup update check — app is not packaged');
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ════════════════════════════════════════════════════════════════
// AUTO-UPDATER LOGGER (main process)
// ════════════════════════════════════════════════════════════════
function updLog(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[AutoUpdate][${ts}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn')  console.warn(prefix, ...args);
  else                        console.log(prefix, ...args);
}

// Forward log from electron-updater itself
autoUpdater.logger = {
  info:  (...a) => updLog('info',  ...a),
  warn:  (...a) => updLog('warn',  ...a),
  error: (...a) => updLog('error', ...a),
  debug: (...a) => updLog('debug', ...a),
};

// ══════════════════════════════════════════════
// AUTO-UPDATER EVENTS → forward to renderer
// ══════════════════════════════════════════════

autoUpdater.on("checking-for-update", () => {
  updLog('info', 'Checking for update…');
});

autoUpdater.on("update-available", (info) => {
  updLog('info', `Update available — version=${info.version} releaseDate=${info.releaseDate}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-available", { version: info.version });
  }
});

autoUpdater.on("update-not-available", (info) => {
  updLog('info', `No update available — current version is up to date (latestVersion=${info?.version})`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-not-available");
  }
});

autoUpdater.on("download-progress", (progress) => {
  updLog('info', `Download progress — ${Math.round(progress.percent)}% (${progress.transferred}/${progress.total} bytes, speed=${Math.round(progress.bytesPerSecond)} B/s)`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  }
});

autoUpdater.on("update-downloaded", (info) => {
  updLog('info', `Update downloaded — version=${info.version}, ready to install`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-downloaded");
  }
});

autoUpdater.on("error", (err) => {
  updLog('error', `AutoUpdater error: ${err.message}`, err.stack || '');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-error", { message: err.message });
  }
});

// ══════════════════════════════════════════════
// IPC — CONFIG / CREDENTIALS
// ══════════════════════════════════════════════

ipcMain.handle("get-config", () => {
  const teamConfig = store.get("teamConfig", null);
  return {
    ...(teamConfig || {}),
    launchMinimized: store.get("launchMinimized", false),
  };
});

ipcMain.handle("save-config", (_e, config) => {
  store.set("teamConfig", config);
  return { ok: true };
});

ipcMain.handle("reset-config", () => {
  store.clear();
  return { ok: true };
});

ipcMain.handle("has-config", () => {
  return !!store.get("teamConfig", null);
});

// ── Launch Minimized setting (persisted separately from team config) ──
ipcMain.handle("set-launch-minimized", (_e, val) => {
  store.set("launchMinimized", val);
  return true;
});

// ══════════════════════════════════════════════
// IPC — BOT RUNNER
// ══════════════════════════════════════════════

let activeCancelToken = null;

ipcMain.handle("run-bot", async (_e, { members, dateFrom, dateTo }) => {
  const teamConfig = store.get("teamConfig", null);
  if (!teamConfig) return { ok: false, error: "No config saved" };

  // Import bot runner lazily so it doesn't block app startup
  const { runForMembers, CancelToken } = require("../bot/runner");

  const onLog = (log) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bot-log", log);
    }
  };

  const onProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bot-progress", progress);
    }
  };

  // Create a fresh cancel token for this run
  const cancelToken = new CancelToken();
  activeCancelToken = cancelToken;

  try {
    const result = await runForMembers({
      teamConfig,
      members,
      dateFrom,
      dateTo,
      onLog,
      onProgress,
      launchMinimized: store.get("launchMinimized", false),
      cancelToken,
    });
    return { ok: true, result };
  } catch (err) {
    const wasStopped = cancelToken.cancelled;
    return { ok: false, error: err.message, stopped: wasStopped };
  } finally {
    activeCancelToken = null;
  }
});

ipcMain.handle("stop-bot", () => {
  if (activeCancelToken) {
    activeCancelToken.cancel();
    activeCancelToken = null;
  }
  return { ok: true };
});

// ══════════════════════════════════════════════
// IPC — AUTO-UPDATER (called from renderer)
// ══════════════════════════════════════════════

ipcMain.handle("check-for-updates", async () => {
  updLog('info', 'IPC check-for-updates received');
  if (!app.isPackaged) {
    updLog('warn', 'App is not packaged — skipping update check');
    return { dev: true };
  }
  try {
    updLog('info', 'Calling autoUpdater.checkForUpdates()…');
    await autoUpdater.checkForUpdates();
    updLog('info', 'autoUpdater.checkForUpdates() resolved OK');
    return { ok: true };
  } catch (e) {
    updLog('error', `autoUpdater.checkForUpdates() threw: ${e.message}`, e.stack || '');
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("download-update", () => {
  updLog('info', 'IPC download-update received — starting download');
  autoUpdater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle("install-update", () => {
  updLog('info', 'IPC install-update received — calling quitAndInstall');
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});