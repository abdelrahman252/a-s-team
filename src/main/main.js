"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require("electron");
const path   = require("path");
const Store  = require("electron-store");
const { autoUpdater } = require("electron-updater");

// ════════════════════════════════════════
// AUTO-UPDATER CONFIG
// ════════════════════════════════════════
autoUpdater.autoDownload    = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;

// ── Full logger — shows in DevTools console AND writes to log file ──
const log = require("electron-log");
log.transports.file.level = "debug";
log.transports.console.level = "debug";
autoUpdater.logger = log;

// ── Helper: show a dialog popup so you always see what happened ──
function showUpdateDialog(title, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title,
      message,
      buttons: ["OK"],
    });
  }
}

// ── GitHub feed — token for private repo ──
autoUpdater.setFeedURL({
  provider: "github",
  owner: "abdelrahman252",
  repo: "a-s-team",
  private: true
});

// ════════════════════════════════════════
// STARTUP PERFORMANCE FLAGS
// ════════════════════════════════════════
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("renderer-process-limit", "1");
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      v8CacheOptions: "bypassHeatCheck",
      spellcheck: false,
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

  if (app.isPackaged) {
    setTimeout(() => {
      log.info("[updater] Starting update check on launch...");
      autoUpdater.checkForUpdates().catch((err) => {
        log.error("[updater] checkForUpdates failed:", err);
        showUpdateDialog("Update Error", "Auto-check failed:\n" + err.message);
      });
    }, 3000);
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ══════════════════════════════════════════════
// AUTO-UPDATER EVENTS
// ══════════════════════════════════════════════

autoUpdater.on("checking-for-update", () => {
  log.info("[updater] Checking for update...");
  // Uncomment the line below if you want a popup every time it checks:
  // showUpdateDialog("Updater", "Checking for updates...");
});

autoUpdater.on("update-available", (info) => {
  log.info("[updater] Update available:", info.version);
  showUpdateDialog("Update Available", `Version ${info.version} is available!\nClick OK then use the update button to download.`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-available", { version: info.version });
  }
});

autoUpdater.on("update-not-available", (info) => {
  log.info("[updater] No update. Current version is latest:", info.version);
  showUpdateDialog("No Update", `You are on the latest version (${info.version}).`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-not-available");
  }
});

autoUpdater.on("download-progress", (progress) => {
  log.info(`[updater] Download progress: ${Math.round(progress.percent)}%`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  }
});

autoUpdater.on("update-downloaded", () => {
  log.info("[updater] Update downloaded, ready to install.");
  showUpdateDialog("Update Ready", "Update downloaded! It will install when you close the app.");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-downloaded");
  }
});

autoUpdater.on("error", (err) => {
  log.error("[updater] Error:", err);
  showUpdateDialog("Update Error", "Updater error:\n" + err.message);
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
  if (!app.isPackaged) {
    showUpdateDialog("Updater", "Running in dev mode — updater is disabled.\nBuild and install the app to test updates.");
    return { dev: true };
  }
  try {
    log.info("[updater] Manual check triggered from renderer");
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    log.error("[updater] Manual check failed:", e);
    showUpdateDialog("Update Error", "Check failed:\n" + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("download-update", () => {
  autoUpdater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});
