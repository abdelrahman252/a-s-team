"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Config
  getConfig:          ()        => ipcRenderer.invoke("get-config"),
  saveConfig:         (config)  => ipcRenderer.invoke("save-config", config),
  resetConfig:        ()        => ipcRenderer.invoke("reset-config"),
  hasConfig:          ()        => ipcRenderer.invoke("has-config"),

  // Settings
  setLaunchMinimized: (val)     => ipcRenderer.invoke("set-launch-minimized", val),

  // Bot
  runBot:             (params)  => ipcRenderer.invoke("run-bot", params),
  stopBot:            ()        => ipcRenderer.invoke("stop-bot"),

  // Bot events (renderer listens)
  onBotLog:           (cb) => ipcRenderer.on("bot-log",      (_e, data) => cb(data)),
  onBotProgress:      (cb) => ipcRenderer.on("bot-progress", (_e, data) => cb(data)),
  offBotLog:          ()   => ipcRenderer.removeAllListeners("bot-log"),
  offBotProgress:     ()   => ipcRenderer.removeAllListeners("bot-progress"),

  // Auto-updater
  getAppVersion:      ()    => ipcRenderer.invoke("get-app-version"),
  checkForUpdates:    ()    => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate:     ()    => ipcRenderer.invoke("download-update"),
  installUpdate:      ()    => ipcRenderer.invoke("install-update"),

  // Auto-updater events (renderer listens)
  onUpdateAvailable:    (cb) => ipcRenderer.on("update-available",     (_e, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on("update-not-available", () => cb()),
  onUpdateProgress:     (cb) => ipcRenderer.on("update-progress",      (_e, p)    => cb(p)),
  onUpdateDownloaded:   (cb) => ipcRenderer.on("update-downloaded",    () => cb()),
  onUpdateError:        (cb) => ipcRenderer.on("update-error",         (_e, err)  => cb(err)),
});
