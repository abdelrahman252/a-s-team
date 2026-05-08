"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path   = require("path");
const Store  = require("electron-store");

// ── Encrypted credential store ──
const store = new Store({
  name: "as-team-config",
  encryptionKey: "as-team-2024-secure-key",
});

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0a0b0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: true,
    // PERF: Show window immediately once ready-to-show fires
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
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
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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

let activeBotProcess = null;

ipcMain.handle("run-bot", async (_e, { members, dateFrom, dateTo }) => {
  const teamConfig = store.get("teamConfig", null);
  if (!teamConfig) return { ok: false, error: "No config saved" };

  // Import bot runner lazily so it doesn't block app startup
  const { runForMembers } = require("../bot/runner");

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

  try {
    const result = await runForMembers({
      teamConfig,
      members,
      dateFrom,
      dateTo,
      onLog,
      onProgress,
      launchMinimized: store.get("launchMinimized", false),
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("stop-bot", () => {
  if (activeBotProcess) {
    activeBotProcess.kill();
    activeBotProcess = null;
  }
  return { ok: true };
});
