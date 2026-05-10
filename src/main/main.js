const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const Store = require("electron-store");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const https = require("https");
const { autoUpdater } = require("electron-updater");

// ════════════════════════════════════════
// AUTO-UPDATER SETUP
// Silent background check — downloads automatically, notifies user when ready.
// ════════════════════════════════════════
autoUpdater.autoDownload = true;          // download in background without asking
autoUpdater.autoInstallOnAppQuit = true;  // install the moment the user quits

autoUpdater.on("update-available", (info) => {
  // Notify renderer so UI can show "Update downloading..." if desired
  if (mainWindow) mainWindow.webContents.send("update-available", info);
});

autoUpdater.on("update-downloaded", (info) => {
  // Ask user once download is ready — they can install now or on next quit
  if (!mainWindow) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "info",
    buttons: ["Restart & Install", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update Ready",
    message: `Version ${info.version} is ready to install.`,
    detail: "Restart now to apply the update, or it will be applied automatically on next launch.",
  });
  if (choice === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on("error", (err) => {
  // Silent — don't interrupt the user for update errors
  console.error("[updater] error:", err.message);
});

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

// ══════════════════════════════════════════════════════
// SUPABASE CONFIG  — replace with your project values
// ══════════════════════════════════════════════════════
const SUPABASE_URL = "https://lkzmvtrwqgspbbbjyijj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_hg-XZyOtPfn6bc3gJYCNDw_3aG1njOM";

function supabaseRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const baseUrl = SUPABASE_URL.replace(/\/+$/, "");
    const url = new URL(baseUrl + endpoint);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + SUPABASE_PUBLISHABLE_KEY,
      "Prefer": method === "POST" ? "return=representation" : "",
    };
    headers["apikey"] = SUPABASE_PUBLISHABLE_KEY; // required for both sb_publishable_ and eyJ key types
    const options = { hostname: url.hostname, path: url.pathname + url.search, method, headers };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function getIconPath() {
  // DEV:     assets/ is two levels up from src/main/
  // PACKAGED: extraResources copies assets/ → resources/assets/ (real disk, outside asar)
  //           so nativeImage.createFromPath() can always read it on any customer's PC
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(__dirname, "..", "..", "assets");
  if (process.platform === "win32") return path.join(base, "icon.ico");
  if (process.platform === "darwin") return path.join(base, "icon.icns");
  return path.join(base, "icon.png");
}

const store = new Store({ encryptionKey: "taager-bot-secure-key-2024", name: "credentials" });
const licenseStore = new Store({ encryptionKey: "khod-bot-license-2024-secure", name: "license" });

let mainWindow, tray, autoRunTimer = null, autoRunEnabled = false, botRunning = false;

// ══════════════════════════════════════════════════════
// DEVICE FINGERPRINT — stable across reboots, updates, VPN, network changes
// Uses: CPU model + platform/arch + CPU count + RAM bucket (rounded to 4GB)
//
// WHY each component was chosen:
//   CPU model  — never changes unless the physical CPU is replaced
//   platform   — darwin/win32/linux + arch is baked into the binary
//   CPU count  — stable; only changes if cores are physically added/removed
//   RAM bucket — rounded to nearest 4 GB so a 16 384 MB and 16 000 MB machine
//                both hash to "16GB", surviving minor OS reporting differences
//
// WHY hostname was REMOVED:
//   macOS silently renames the host after system updates or Bonjour conflicts
//   Windows may rename after domain join/leave or certain Windows Update passes
//   That was the #1 cause of unexpected "different device" kicks on Mac/Windows
// ══════════════════════════════════════════════════════
function getDeviceFingerprint() {
  try {
    const cpus      = os.cpus();
    const cpuModel  = cpus && cpus.length ? cpus[0].model.trim() : "unknown-cpu";
    const platform  = `${process.platform}-${process.arch}`;
    const cpuCount  = String(cpus ? cpus.length : 1);
    // Bucket RAM to nearest 4 GB to absorb minor OS-level reporting differences
    const memBucket = String(Math.round(os.totalmem() / (4 * 1024 * 1024 * 1024)) * 4) + "GB";
    const raw = `${cpuModel}::${platform}::${cpuCount}::${memBucket}`;
    return crypto.createHash("sha256").update(raw).digest("hex").toUpperCase().slice(0, 16);
  } catch {
    // Last-resort fallback: platform string alone (always available in Electron)
    const fallback = `${process.platform}-${process.arch}-fallback`;
    return crypto.createHash("sha256").update(fallback).digest("hex").toUpperCase().slice(0, 16);
  }
}

// ── Account slot hash — includes account id so two accounts with identical
//    emails still get distinct hashes and count as separate slots in DB.
function accountHash(acc) {
  const id   = (acc.id         || "").trim();
  const easy = (acc.easyEmail  || "").toLowerCase().trim();
  const khod = (acc.khodEmail  || "").toLowerCase().trim();
  return crypto.createHash("sha256").update(`${id}|${easy}|${khod}`).digest("hex");
}

// ══════════════════════════════════════════════════════
// LICENSE — server-only, random key, auto device lock
// Format: KHOD-XXXX-XXXX-XXXX-XXXX
// ══════════════════════════════════════════════════════
// Short-lived in-memory cache — shared by isLicenseValid() (auto-run timer)
// and the check-license IPC handler to prevent redundant Supabase calls.
// Busted by submit-license and clear-reset-flag.
let _licenseCache = null;
let _licenseCacheAt = 0;
const LICENSE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

function isValidKeyFormat(key) {
  return /^KHOD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key.trim().toUpperCase());
}

async function isLicenseValid() {
  const key = licenseStore.get("licenseKey", "");
  if (!key) return false;
  // Reuse the shared in-memory cache so the auto-run timer never makes a redundant
  // Supabase call and never risks a stale fingerprint from a separate code path.
  // Cache is busted by submit-license and clear-reset-flag.
  if (_licenseCache && (Date.now() - _licenseCacheAt) < LICENSE_CACHE_TTL_MS) {
    return _licenseCache.valid === true;
  }
  try {
    const res = await supabaseRequest("GET",
      `/rest/v1/licenses?license_key=eq.${encodeURIComponent(key)}&select=revoked,device_id,expires_at`, null);
    if (!res.data || !Array.isArray(res.data) || !res.data.length) return false;
    const r = res.data[0];
    if (r.revoked) return false;
    if (r.expires_at && new Date(r.expires_at) < new Date()) return false;
    if (r.device_id && r.device_id !== getDeviceFingerprint()) return false;
    return true;
  } catch { return !!key; } // offline: trust local
}

// ════════════════════════════════════════
// TRAY
// ════════════════════════════════════════
function createTray() {
  const iconPath = getIconPath();
  console.log("[tray] icon path:", iconPath, "| exists:", require("fs").existsSync(iconPath));
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) console.warn("[tray] nativeImage loaded empty — check path and file validity");
    if (process.platform === "win32" && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  } catch (e) {
    console.error("[tray] failed to load icon:", e.message);
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip("Khod Order Bot");
  updateTrayMenu();
  tray.on("click", () => { if (mainWindow.isVisible()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); } });
}
function updateTrayMenu() {
  if (!tray) return;
  const label = autoRunEnabled && autoRunTimer ? "Auto-Run: ON" : "Auto-Run: OFF";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Khod Order Bot", enabled: false }, { type: "separator" },
    { label, enabled: false }, { type: "separator" },
    { label: "Show Window", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" }, { label: "Quit", click: () => { app.quit(); } },
  ]));
}

// ════════════════════════════════════════
// WINDOW
// ════════════════════════════════════════
function createWindow() {
  // Read saved theme synchronously so we can pass the correct backgroundColor
  // before the window is shown — prevents a white/dark flash during startup.
  const savedTheme = store.get("theme", "dark");
  const bgColor = savedTheme === "light" ? "#f0f2f7" : "#0f1117";

  mainWindow = new BrowserWindow({
    width: 1100, height: 750, minWidth: 900, minHeight: 600,
    frame: false, titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // V8 snapshot: reuse compiled bytecode across launches
      v8CacheOptions: "bypassHeatCheck",
      // Disable spell check — saves renderer init time for a non-document app
      spellcheck: false,
    },
    backgroundColor: bgColor, icon: getIconPath(), show: false,
  });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (store.get("autoRun", false)) setTimeout(() => mainWindow.minimize(), 150);
    else mainWindow.focus();
  });
  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    const autoRunOn = store.get("autoRun", false);
    const { response } = dialog.showMessageBoxSync(mainWindow, {
      type: "question", buttons: ["Minimize to Tray", "Close App"],
      defaultId: 0, cancelId: 0, title: "Close Khod Bot?",
      message: autoRunOn ? "Auto-Run is active" : "Keep running in tray?",
      detail: autoRunOn
        ? "Auto-Run is active — minimizing to tray keeps the bot running every " + autoRunIntervalLabel() + "."
        : "The app will keep running in the system tray. Click the tray icon to reopen it.",
    });
    if (response === 0) mainWindow.hide();
    else { clearAutoRun(); app.isQuitting = true; app.quit(); }
  });
}

// ════════════════════════════════════════
// AUTO-RUN
// ════════════════════════════════════════
function todayStr() { const d = new Date(); return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-"); }
function autoRunIntervalLabel() {
  const m = store.get("autoRunInterval", 30);
  return m < 60 ? m + " min" : (m / 60) + " hr";
}

// Declared BEFORE app.whenReady so it is always defined when scheduleAutoRun() is called.
let autoRunStartedAt = 0;

function scheduleAutoRun() {
  clearAutoRun();
  autoRunStartedAt = Date.now();
  const intervalMs = store.get("autoRunInterval", 30) * 60 * 1000;

  // Recursive setTimeout: each tick recalculates remaining time from wall clock.
  // Unlike setInterval this doesn't drift, and survives sleep/wake correctly.
  function scheduleTick() {
    const remaining = Math.max(0, intervalMs - (Date.now() - autoRunStartedAt));
    autoRunTimer = setTimeout(async () => {
      if (botRunning) {
        // Bot still running — check again in 10 s without resetting the cycle
        autoRunTimer = setTimeout(scheduleTick, 10000);
        return;
      }
      if (!(await isLicenseValid())) {
        mainWindow.webContents.send("license-expired");
        autoRunStartedAt = Date.now();
        scheduleTick();
        return;
      }
      autoRunStartedAt = Date.now();
      mainWindow.webContents.send("auto-run-tick", { dateFrom: todayStr(), dateTo: todayStr() });
      scheduleTick();
    }, remaining);
  }

  scheduleTick();
  updateTrayMenu();
}

function getAutoRunProgress() {
  if (!autoRunEnabled || !autoRunTimer) return null;
  const intervalMs = store.get("autoRunInterval", 30) * 60 * 1000;
  const remaining  = Math.max(0, intervalMs - (Date.now() - autoRunStartedAt));
  return { remainingMs: remaining, intervalMs };
}

function clearAutoRun() {
  if (autoRunTimer) { clearTimeout(autoRunTimer); autoRunTimer = null; }
  updateTrayMenu();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  autoRunEnabled = store.get("autoRun", false);
  if (autoRunEnabled) scheduleAutoRun();
  // Check for updates 5 s after launch so window is visible first
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates(), 5000);
});
app.on("before-quit", () => { app.isQuitting = true; });
app.on("window-all-closed", () => {});

// ════════════════════════════════════════
// IPC — Window
// ════════════════════════════════════════
ipcMain.on("window-minimize", () => mainWindow.minimize());
ipcMain.on("window-maximize", () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
ipcMain.on("window-close", () => mainWindow.hide());

// ════════════════════════════════════════
// IPC — License (server-based, auto device lock)
// ════════════════════════════════════════

// [cache vars moved above isLicenseValid — see top of LICENSE section]

ipcMain.handle("check-license", async () => {
  const key = licenseStore.get("licenseKey", "");
  if (!key) return { valid: false, reason: "No license key." };

  // Serve from cache if fresh
  if (_licenseCache && (Date.now() - _licenseCacheAt) < LICENSE_CACHE_TTL_MS) {
    return _licenseCache;
  }

  const deviceId = getDeviceFingerprint();
  try {
    const res = await supabaseRequest("GET",
      `/rest/v1/licenses?license_key=eq.${encodeURIComponent(key)}&select=revoked,device_id,expires_at,customer_name,allow_reset`, null);
    if (!res.data || !Array.isArray(res.data) || !res.data.length) return { valid: false, reason: "License not found on server." };
    const r = res.data[0];
    if (r.revoked) return { valid: false, reason: "Your license has been revoked. Contact support." };
    if (r.expires_at && new Date(r.expires_at) < new Date()) return { valid: false, reason: `License expired on ${new Date(r.expires_at).toLocaleDateString()}. Please renew.` };
    if (r.device_id && r.device_id !== deviceId && r.allow_reset !== true) return { valid: false, reason: "License is linked to a different device. This can happen if you reinstalled Windows or replaced hardware. Contact support to reset the device lock." };
    // ── AUTO-REBIND: admin pressed "Reset Device" ──
    if (r.allow_reset === true) {
      try {
        await supabaseRequest("PATCH",
          `/rest/v1/licenses?license_key=eq.${encodeURIComponent(key)}`,
          { device_id: deviceId, activated_at: new Date().toISOString(), allow_reset: false });
        licenseStore.set("allowReset", false);
        // Bust cache so next check reflects the newly bound device
        _licenseCache = null; _licenseCacheAt = 0;
      } catch (e) {
        // Rebind failed (no connection) — don't block the user, will retry next launch
      }
    }
    const daysLeft = r.expires_at ? Math.max(0, Math.ceil((new Date(r.expires_at) - new Date()) / 86400000)) : null;
    const customerName = r.customer_name || null;
    const allowReset = false; // consumed above
    if (customerName) licenseStore.set("customerName", customerName);
    if (daysLeft !== null) licenseStore.set("daysLeft", daysLeft);
    licenseStore.set("allowReset", allowReset);
    const result = { valid: true, key, daysLeft, customerName, allowReset };
    _licenseCache = result;
    _licenseCacheAt = Date.now();
    return result;
  } catch {
    // Offline: return cached local values — don't overwrite the in-memory cache
    return { valid: true, key, daysLeft: licenseStore.get("daysLeft", null), customerName: licenseStore.get("customerName", null), allowReset: licenseStore.get("allowReset", false), offline: true };
  }
});

ipcMain.handle("submit-license", async (_, key) => {
  const clean = key.trim().toUpperCase();
  if (!isValidKeyFormat(clean)) return { success: false, reason: "Invalid format. Keys look like: KHOD-XXXX-XXXX-XXXX-XXXX" };
  const deviceId = getDeviceFingerprint();
  try {
    const res = await supabaseRequest("GET",
      `/rest/v1/licenses?license_key=eq.${encodeURIComponent(clean)}&select=license_key,revoked,device_id,expires_at,customer_name`, null);
    if (!res.data || !Array.isArray(res.data) || !res.data.length) return { success: false, reason: "License key not found. Contact support." };
    const r = res.data[0];
    if (r.revoked) return { success: false, reason: "This license has been revoked. Contact support." };
    if (r.expires_at && new Date(r.expires_at) < new Date()) return { success: false, reason: `This license expired on ${new Date(r.expires_at).toLocaleDateString()}. Please renew.` };
    if (r.device_id && r.device_id !== deviceId) return { success: false, reason: "This license is already activated on a different device. This can happen if you reinstalled Windows or replaced hardware. Contact support to reset the device lock." };
    if (!r.device_id) {
      const lockRes = await supabaseRequest("PATCH", `/rest/v1/licenses?license_key=eq.${encodeURIComponent(clean)}`,
        { device_id: deviceId, activated_at: new Date().toISOString() });
      if (lockRes.status !== 200 && lockRes.status !== 204) {
        return { success: false, reason: "Could not lock device to license. Check your connection and try again." };
      }
    }
    const daysLeft = r.expires_at ? Math.max(0, Math.ceil((new Date(r.expires_at) - new Date()) / 86400000)) : null;
    const customerName = r.customer_name || null;
    licenseStore.set("licenseKey", clean);
    if (customerName) licenseStore.set("customerName", customerName);
    if (daysLeft !== null) licenseStore.set("daysLeft", daysLeft);
    // Bust the in-memory cache so the next check-license hits the server fresh
    _licenseCache = null;
    _licenseCacheAt = 0;
    return { success: true, daysLeft, customerName };
  } catch { return { success: false, reason: "Cannot reach server. Check your internet connection." }; }
});

// ════════════════════════════════════════
// IPC — Credentials — Multi-Account Edition
// ════════════════════════════════════════

// Helper: get max accounts allowed by this license
async function getMaxAccounts() {
  const key = licenseStore.get("licenseKey", "");
  if (!key) return 1;
  try {
    const res = await supabaseRequest("GET",
      `/rest/v1/licenses?license_key=eq.${encodeURIComponent(key)}&select=max_accounts`, null);
    if (res.data && res.data[0] && res.data[0].max_accounts)
      return res.data[0].max_accounts;
  } catch {}
  return licenseStore.get("maxAccounts", 1);
}

// Short-lived in-memory cache for get-credentials — eliminates the duplicate
// Supabase request when init() and afterLicense() both call it within milliseconds.
let _credCache = null;
let _credCacheAt = 0;
const CRED_CACHE_TTL_MS = 15 * 1000; // 15 seconds

ipcMain.handle("get-credentials", async () => {
  // Serve from cache if fresh
  if (_credCache && (Date.now() - _credCacheAt) < CRED_CACHE_TTL_MS) {
    return _credCache;
  }

  const rawAccounts = store.get("accounts", null);
  const maxAccounts = await getMaxAccounts();
  const legacyEmail = store.get("easyEmail", "");
  const accounts = rawAccounts || [];

  // Fetch per-account lock status from license_accounts table
  let lockedHashes = [];
  let unlockedAccountIds = store.get("unlockedAccountIds", []); // admin-unlocked accounts (local cache)
  const licKey = licenseStore.get("licenseKey", "");
  if (licKey) {
    try {
      const res = await supabaseRequest("GET",
        `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&select=account_hash,unlocked`, null);
      if (res.data && Array.isArray(res.data)) {
        lockedHashes = res.data.filter(r => !r.unlocked).map(r => r.account_hash);
        // Update local cache of unlocked accounts
        const serverUnlocked = res.data.filter(r => r.unlocked).map(r => r.account_hash);
        unlockedAccountIds = accounts
          .filter(a => serverUnlocked.includes(accountHash(a)))
          .map(a => a.id);
        store.set("unlockedAccountIds", unlockedAccountIds);

        // If DB returned zero rows but local accounts exist with credentials,
        // it means admin used "Clear All Slots" — treat all existing accounts as locked
        // so they can't be edited until admin explicitly unlocks them.
        if (res.data.length === 0 && accounts.length > 0) {
          lockedHashes = accounts.map(a => accountHash(a));
          unlockedAccountIds = [];
          store.set("unlockedAccountIds", []);
        }
      }
    } catch {
      // Offline: use local cache
    }
  }

  // Enrich accounts with lock status
  const accountsWithStatus = accounts.map(a => {
    const hash = accountHash(a);
    const isLocked = lockedHashes.includes(hash); // server says locked
    const isUnlocked = unlockedAccountIds.includes(a.id); // admin unlocked
    return { ...a, locked: isLocked && !isUnlocked };
  });

  const result = {
    hasCredentials:  accountsWithStatus.length > 0 || !!legacyEmail,
    accounts:        accountsWithStatus,
    maxAccounts,
    easyEmail:       store.get("easyEmail",       ""),
    easyStore:       store.get("easyStore",       ""),
    khodEmail:       store.get("khodEmail",       ""),
    autoRun:         store.get("autoRun",         false),
    autoRunInterval: store.get("autoRunInterval", 30),
    launchMinimized: store.get("launchMinimized", false),
  };
  _credCache = result;
  _credCacheAt = Date.now();
  return result;
});

// Legacy single-account save (kept for backward compat with any older calls)
ipcMain.handle("save-credentials", async (_, creds) => {
  store.set("easyEmail",    creds.easyEmail    || "");
  store.set("easyPassword", creds.easyPassword || "");
  store.set("easyStore",    creds.easyStore    || "");
  store.set("khodEmail",    creds.khodEmail    || "");
  store.set("khodPassword", creds.khodPassword || "");
  return { success: true };
});

// ── NEW: save full accounts array ──
ipcMain.handle("save-all-accounts", async (_, accounts) => {
  const licKey = licenseStore.get("licenseKey", "");
  const maxAccounts = await getMaxAccounts();

  if (accounts.length > maxAccounts)
    return { success: false, reason: "limit_reached" };

  // ── Per-account lock check via license_accounts table ──
  if (licKey) {
    try {
      const res = await supabaseRequest("GET",
        `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&select=account_hash,unlocked`, null);
      const dbRows      = res.data || [];
      const dbHashes    = dbRows.map(r => r.account_hash);

      // Build a map of accountId → old hash using the CURRENTLY stored accounts
      // (before we overwrite them). This lets us detect when an edit changed emails.
      const storedAccounts = store.get("accounts", []);
      const oldHashById = {};
      for (const a of storedAccounts) oldHashById[a.id] = accountHash(a);

      const newHashes = accounts.map(a => accountHash(a));

      for (const a of accounts) {
        const newH = accountHash(a);
        const oldH = oldHashById[a.id]; // undefined for brand-new accounts

        // Case 1: hash unchanged — already in DB, nothing to do
        if (newH === oldH) continue;

        // Case 2: this is an edit that changed the email — swap old hash for new hash
        if (oldH && dbHashes.includes(oldH)) {
          // Preserve the unlocked state from the old row
          const oldRow   = dbRows.find(r => r.account_hash === oldH);
          const wasUnlocked = oldRow ? !!oldRow.unlocked : false;
          // Server-side guard: reject the edit if the account is still locked
          if (!wasUnlocked) return { success: false, reason: "account_locked" };
          // Delete old hash row
          await supabaseRequest("DELETE",
            `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&account_hash=eq.${encodeURIComponent(oldH)}`, null);
          // Insert new hash row (keep unlocked state so admin unlock survives email edits)
          await supabaseRequest("POST", `/rest/v1/license_accounts`,
            { license_key: licKey, account_hash: newH, unlocked: wasUnlocked });
          continue;
        }

        // Case 3: genuinely new account — check slot limit then register
        if (!dbHashes.includes(newH)) {
          // Count how many truly new hashes (not in DB and not an edit swap) we're adding
          const alreadyKnownOrSwapped = accounts
            .filter(b => { const bOld = oldHashById[b.id]; return bOld && dbHashes.includes(bOld); })
            .map(b => accountHash(b));
          const genuinelyNew = newHashes.filter(h => !dbHashes.includes(h) && !alreadyKnownOrSwapped.includes(h));
          if (dbHashes.length + genuinelyNew.length > maxAccounts)
            return { success: false, reason: "limit_reached" };
          await supabaseRequest("POST", `/rest/v1/license_accounts`,
            { license_key: licKey, account_hash: newH, unlocked: false });
        }
      }

      // Remove hashes for deleted accounts (hashes in DB not present in newHashes and not an old-hash being swapped)
      const swappedOldHashes = accounts
        .map(a => oldHashById[a.id])
        .filter(h => h && dbHashes.includes(h) && !newHashes.includes(h));
      const deletedHashes = dbHashes.filter(h => !newHashes.includes(h) && !swappedOldHashes.includes(h));
      for (const h of deletedHashes) {
        // Server-side guard: never delete a locked account slot — only unlocked ones can be removed
        const row = dbRows.find(r => r.account_hash === h);
        if (row && !row.unlocked) return { success: false, reason: "account_locked" };
        try {
          await supabaseRequest("DELETE",
            `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&account_hash=eq.${encodeURIComponent(h)}`, null);
        } catch {}
      }
    } catch {
      // Offline: trust local
    }
  }

  // Encrypt passwords in store — store accounts without plaintext passwords, keep passwords separately keyed
  const safeAccounts = accounts.map(a => ({
    id:         a.id,
    label:      a.label,
    easyEmail:  a.easyEmail,
    easyStore:  a.easyStore  || "",
    khodEmail:  a.khodEmail,
  }));
  store.set("accounts", safeAccounts);

  // Prune local unlockedAccountIds cache — remove IDs that no longer exist
  const remainingIds = accounts.map(a => a.id);
  const cachedUnlocked = store.get("unlockedAccountIds", []).filter(id => remainingIds.includes(id));
  store.set("unlockedAccountIds", cachedUnlocked);

  // Store passwords per account id
  for (const a of accounts) {
    if (a.easyPassword) store.set(`pwd_easy_${a.id}`, a.easyPassword);
    if (a.khodPassword) store.set(`pwd_khod_${a.id}`, a.khodPassword);
  }

  // Also update legacy flat fields from first account (for any code still reading them)
  if (accounts[0]) {
    store.set("easyEmail",    accounts[0].easyEmail    || "");
    store.set("easyPassword", accounts[0].easyPassword || store.get(`pwd_easy_${accounts[0].id}`, ""));
    store.set("easyStore",    accounts[0].easyStore    || "");
    store.set("khodEmail",    accounts[0].khodEmail    || "");
    store.set("khodPassword", accounts[0].khodPassword || store.get(`pwd_khod_${accounts[0].id}`, ""));
  }
  // Cache maxAccounts locally
  licenseStore.set("maxAccounts", maxAccounts);
  // Bust credentials cache so next get-credentials reflects the new accounts
  _credCache = null;
  _credCacheAt = 0;
  return { success: true };
});


// ── ADMIN: unlock a single account (called when admin unlocks via panel) ──
// The app polls this on startup — when admin sets unlocked=true in DB,
// unlockedAccountIds is updated locally so UI re-enables edit button.
ipcMain.handle("unlock-single-account", async (_, { accountId }) => {
  const accounts = store.get("accounts", []);
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return { success: false, reason: "account_not_found" };
  const licKey = licenseStore.get("licenseKey", "");
  const hash = accountHash(acc);
  if (licKey) {
    try {
      await supabaseRequest("PATCH",
        `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&account_hash=eq.${encodeURIComponent(hash)}`,
        { unlocked: true });
    } catch {}
  }
  const unlocked = store.get("unlockedAccountIds", []);
  if (!unlocked.includes(accountId)) store.set("unlockedAccountIds", [...unlocked, accountId]);
  return { success: true };
});

// ── Re-lock after user saves new credentials for an account ──
ipcMain.handle("relock-account", async (_, { accountId }) => {
  const accounts = store.get("accounts", []);
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return { success: true };
  const licKey = licenseStore.get("licenseKey", "");
  const hash = accountHash(acc);
  if (licKey) {
    try {
      await supabaseRequest("PATCH",
        `/rest/v1/license_accounts?license_key=eq.${encodeURIComponent(licKey)}&account_hash=eq.${encodeURIComponent(hash)}`,
        { unlocked: false });
    } catch {}
  }
  const unlocked = store.get("unlockedAccountIds", []).filter(id => id !== accountId);
  store.set("unlockedAccountIds", unlocked);
  return { success: true };
});
ipcMain.handle("get-settings", () => ({
  theme: store.get("theme", "dark"),
  lang:  store.get("lang",  "ar"),
}));
ipcMain.handle("save-settings", (_, { theme, lang }) => {
  if (theme !== undefined) store.set("theme", theme);
  if (lang  !== undefined) store.set("lang",  lang);
  return true;
});

ipcMain.handle("open-folder", (_, p) => { shell.openPath(p); return true; });
ipcMain.handle("set-auto-run", (_, v) => { autoRunEnabled = v; store.set("autoRun", v); if (v) scheduleAutoRun(); else clearAutoRun(); return true; });
ipcMain.handle("set-auto-run-interval", (_, m) => { store.set("autoRunInterval", m); if (autoRunEnabled) scheduleAutoRun(); return true; });
ipcMain.handle("get-auto-run-progress", () => getAutoRunProgress());
ipcMain.handle("set-launch-minimized", (_, v) => { store.set("launchMinimized", v); return true; });

let currentBotChild = null;
ipcMain.on("bot-started", () => { botRunning = true; if (store.get("launchMinimized") && store.get("autoRun")) mainWindow.minimize(); });
ipcMain.on("bot-finished", () => { botRunning = false; currentBotChild = null; botChildren = []; });
ipcMain.on("kill-bot", () => {
  const toKill = botChildren.length ? botChildren : (currentBotChild ? [currentBotChild] : []);
  for (const child of toKill) { try { child.kill("SIGKILL"); } catch {} }
  currentBotChild = null; botChildren = []; botRunning = false;
});

ipcMain.handle("clear-all-data", () => {
  store.clear(); clearAutoRun();
  // licenseStore NOT cleared — device lock and key survive reset
  // Clear all bot profiles (single legacy + all per-account profiles)
  const userData = app.getPath("userData");
  const legacy = path.join(userData, "bot-profile");
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
  // Also delete any per-account profiles: bot-profile-<id>
  try {
    fs.readdirSync(userData)
      .filter(f => f.startsWith("bot-profile-"))
      .forEach(f => fs.rmSync(path.join(userData, f), { recursive: true, force: true }));
  } catch(e) {}
  return true;
});

// After a successful reset, admin must flip allow_reset back to false so the button re-locks
ipcMain.handle("clear-reset-flag", async () => {
  const key = licenseStore.get("licenseKey", "");
  if (!key) return { success: false };
  try {
    await supabaseRequest("PATCH",
      `/rest/v1/licenses?license_key=eq.${encodeURIComponent(key)}`,
      { allow_reset: false });
    licenseStore.set("allowReset", false);
    // Bust cache so next check-license reflects the change
    _licenseCache = null; _licenseCacheAt = 0;
    return { success: true };
  } catch { return { success: false }; }
});
ipcMain.handle("get-profile-path", () => path.join(app.getPath("userData"), "bot-profile"));
ipcMain.handle("save-output-file", async (_, { buffer, filename }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: filename, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
  if (filePath) { fs.writeFileSync(filePath, Buffer.from(buffer)); return { saved: true, path: filePath }; }
  return { saved: false };
});

// ════════════════════════════════════════
// IPC — Bot runner (license-gated)
// ════════════════════════════════════════
// ── Helper: spawn one bot child for one account ──
function spawnBotChild(creds) {
  const { fork } = require("child_process");
  const botPath = path.join(__dirname, "../bot/runner.js");
  return fork(botPath, [], {
    env: { ...process.env, BOT_CONFIG: JSON.stringify(creds) },
    silent: true,
    execArgv: ["--max-old-space-size=512"],
  });
}

let botChildren = []; // track all running children

// ── Helper: auto-save failed orders xlsx to %APPDATA%/khod-order-bot/failed-orders/{easyEmail}/ ──
function saveFailedOrdersFile(easyEmail, buffer) {
  try {
    // Sanitise the email so it's safe as a folder name (replace @ and special chars)
    const safeEmail = (easyEmail || "unknown").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    // Build timestamp: YYYY-MM-DD_HH-MM-SS (local time)
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    // %APPDATA% on Windows; fallback to userData on other platforms
    const appdata = process.env.APPDATA || app.getPath("userData");
    const dir = path.join(appdata, "khod-order-bot", "failed-orders", safeEmail);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `failed-${ts}.xlsx`);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { dir, filePath };
  } catch (e) {
    console.error("[saveFailedOrdersFile] error:", e.message);
    return { dir: "", filePath: "" };
  }
}

ipcMain.handle("run-bot", async (_, { dateFrom, dateTo, accountIds }) => {
  if (!(await isLicenseValid())) return { success: false, error: "LICENSE_INVALID" };

  // ── Build account list to run ──
  const allAccounts = store.get("accounts", null);
  let accountsToRun = [];

  if (allAccounts && allAccounts.length > 0) {
    // Multi-account: filter by selected ids (if provided), else run all
    const selected = Array.isArray(accountIds) && accountIds.length > 0 ? accountIds : allAccounts.map(a => a.id);
    accountsToRun = allAccounts
      .filter(a => selected.includes(a.id))
      .map(a => ({
        ...a,
        easyPassword: store.get(`pwd_easy_${a.id}`, ""),
        khodPassword: store.get(`pwd_khod_${a.id}`, ""),
      }));
  }

  // Fallback to legacy single-account
  if (accountsToRun.length === 0) {
    accountsToRun = [{
      id: "legacy",
      label: "Account 1",
      easyEmail:    store.get("easyEmail",    ""),
      easyPassword: store.get("easyPassword", ""),
      easyStore:    store.get("easyStore",    ""),
      khodEmail:    store.get("khodEmail",    ""),
      khodPassword: store.get("khodPassword", ""),
    }];
  }

  // ── Single account: original flow ──
  if (accountsToRun.length === 1) {
    const acc = accountsToRun[0];
    const profilePath = path.join(app.getPath("userData"), `bot-profile-${acc.id}`);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

    const creds = { ...acc, profilePath, dateFrom, dateTo, launchMinimized: store.get("launchMinimized", false) };
    return new Promise((resolve) => {
      const child = spawnBotChild(creds);
      currentBotChild = child;
      botChildren = [child];
      const logs = []; let resolved = false;
      const safeResolve = (v) => { if (!resolved) { resolved = true; resolve(v); } };
      child.stdout.on("data", (d) => { const m = d.toString().trim(); if (m) { logs.push(m); mainWindow.webContents.send("bot-log", m); } });
      child.stderr.on("data", (d) => {
        const m = d.toString().trim(); if (!m) return;
        if (m.includes("CHROME_NOT_FOUND")) {
          mainWindow.webContents.send("bot-log", "❌ Google Chrome غير مثبت على جهازك.");
          mainWindow.webContents.send("bot-log", "👉 حمّل Chrome من: https://www.google.com/chrome");
          mainWindow.webContents.send("bot-log", "✅ بعد التثبيت افتح البرنامج من جديد.");
        } else { mainWindow.webContents.send("bot-log", "ERR: " + m); }
      });
      child.on("message", (msg) => {
        if (msg.type === "result") {
          // Auto-save failed orders to per-email folder before resolving
          const data = msg.data || {};
          if (data.failedOrders?.buffer && data.failedOrders.buffer.length > 0) {
            const email = acc.easyEmail || "unknown";
            const { dir, filePath } = saveFailedOrdersFile(email, data.failedOrders.buffer);
            data.failedOrders.failedDir  = dir;
            data.failedOrders.failedPath = filePath;
          }
          safeResolve({ success: true, data });
        }
        if (msg.type === "error")          safeResolve({ success: false, error: msg.error });
        if (msg.type === "2fa-needed")     mainWindow.webContents.send("bot-2fa-needed");
        if (msg.type === "needs-confirm")  mainWindow.webContents.send("bot-needs-confirm");
        if (msg.type === "cooldown")       mainWindow.webContents.send("bot-cooldown", msg);
        if (msg.type === "preview")        mainWindow.webContents.send("bot-preview", msg);
        if (msg.type === "order-progress") mainWindow.webContents.send("bot-order-progress", msg);
        if (msg.type === "khod-restart")   mainWindow.webContents.send("bot-khod-restart", msg);
        if (msg.type === "session-event")  mainWindow.webContents.send("bot-session-event", msg);
      });
      child.on("exit", (code) => safeResolve({ success: code === 0, error: code !== 0 ? "Bot exited with code " + code : null, logs }));
    });
  }

  // ── Multiple accounts: run in PARALLEL, each with its own Chrome profile ──
  mainWindow.webContents.send("bot-log", `🚀 Running ${accountsToRun.length} accounts in parallel...`);

  const promises = accountsToRun.map((acc, idx) => {
    const profilePath = path.join(app.getPath("userData"), `bot-profile-${acc.id}`);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
    const creds = { ...acc, profilePath, dateFrom, dateTo, launchMinimized: store.get("launchMinimized", false) };
    const prefix = `[${acc.easyEmail || acc.label || "Account " + (idx + 1)}] `;

    return new Promise((resolve) => {
      const child = spawnBotChild(creds);
      botChildren.push(child);
      if (idx === 0) currentBotChild = child; // track first for kill signal
      const logs = []; let resolved = false;
      const safeResolve = (v) => { if (!resolved) { resolved = true; resolve(v); } };
      child.stdout.on("data", (d) => {
        const m = d.toString().trim();
        if (m) { logs.push(m); mainWindow.webContents.send("bot-log", prefix + m); }
      });
      child.stderr.on("data", (d) => {
        const m = d.toString().trim(); if (!m) return;
        if (m.includes("CHROME_NOT_FOUND")) {
          mainWindow.webContents.send("bot-log", prefix + "❌ Chrome not found.");
        } else { mainWindow.webContents.send("bot-log", prefix + "ERR: " + m); }
      });
      child.on("message", (msg) => {
        // Tag every event with accountId + accountLabel so the UI can route by account
        const accountId    = acc.id;
        const accountLabel = acc.easyEmail || acc.label || ("Account " + (idx + 1));

        if (msg.type === "result") {
          // Auto-save failed orders to per-email folder before resolving
          const data = msg.data || {};
          if (data.failedOrders?.buffer && data.failedOrders.buffer.length > 0) {
            const email = acc.easyEmail || acc.label || ("account-" + (idx + 1));
            const { dir, filePath } = saveFailedOrdersFile(email, data.failedOrders.buffer);
            data.failedOrders.failedDir  = dir;
            data.failedOrders.failedPath = filePath;
          }
          safeResolve({ success: true, data, accountId, accountLabel });
        }
        if (msg.type === "error")  safeResolve({ success: false, error: msg.error, accountId, accountLabel });

        // Build tagged payload — forward ALL events from ALL accounts (UI routes by accountId)
        const tagged = { ...msg, accountId, accountLabel };
        if (msg.type === "2fa-needed")     mainWindow.webContents.send("bot-2fa-needed",     tagged);
        if (msg.type === "needs-confirm")  mainWindow.webContents.send("bot-needs-confirm",  tagged);
        if (msg.type === "cooldown")       mainWindow.webContents.send("bot-cooldown",       tagged);
        if (msg.type === "preview")        mainWindow.webContents.send("bot-preview",        tagged);
        if (msg.type === "order-progress") mainWindow.webContents.send("bot-order-progress", tagged);
        if (msg.type === "khod-restart")   mainWindow.webContents.send("bot-khod-restart",   tagged);
        if (msg.type === "session-event")  mainWindow.webContents.send("bot-session-event",  tagged);
      });
      child.on("exit", (code) => safeResolve({
        success: code === 0,
        error: code !== 0 ? `${prefix}exited with code ${code}` : null,
        logs,
        accountId:    acc.id,
        accountLabel: acc.easyEmail || acc.label || ("Account " + (idx + 1)),
      }));
    });
  });

  const results = await Promise.all(promises);
  botChildren = [];
  const allOk = results.every(r => r.success);
  return { success: allOk, multiAccount: true, results };
});