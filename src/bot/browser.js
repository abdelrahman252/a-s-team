/**
 * browser.js — Real Chrome via CDP attach, persistent dedicated profile
 *
 * STRATEGY
 * --------
 *   1. We `child_process.spawn` the user's REAL installed Chrome ourselves
 *      with --remote-debugging-port + --user-data-dir pointing at a
 *      dedicated profile. Because we're not Playwright, Chrome boots with
 *      ZERO automation flags injected. From TikTok's POV it is a normal
 *      user Chrome.
 *
 *   2. We then call `chromium.connectOverCDP` to attach Playwright as a
 *      plain DevTools client. CDP is the same protocol Chrome DevTools
 *      itself uses — no bot signature.
 *
 *   3. Because the profile dir is dedicated and persistent, login cookies
 *      survive across runs. The user logs into TikTok ONCE inside this
 *      spawned Chrome. Every subsequent run boots straight into a
 *      logged-in state.
 *
 * FLAGS REMOVED vs earlier version (all caused Chrome warning banners):
 *   --use-mock-keychain      → macOS-only, triggers banner on Windows
 *   --password-store=basic   → triggers banner on newer Chrome
 *   --metrics-recording-only → deprecated, triggers warning
 *   --no-service-autorun     → deprecated, triggers warning
 *   --disable-extensions-except= → conflicts with real Chrome
 *
 * Lifecycle:
 *   launchChrome(onLog, profileKey, launchMinimized) → { context, page }
 *   closeChrome(context, onLog)
 *   forceRefreshSession(onLog)
 */

const { chromium } = require("playwright-core");
const { spawn }    = require("child_process");
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const net  = require("net");
const http = require("http");

let spawnedChromeProcess = null;
let spawnedChromePort    = null;

// ─────────────────────────────────────────────────
// PATHS
// ─────────────────────────────────────────────────
function getProfileDir(profileKey) {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "browser-profiles", profileKey || "default");
  } catch {
    return path.join(os.homedir(), `.as-team-${profileKey || "default"}`);
  }
}

function findChromeExecutable() {
  const platform = process.platform;
  const candidates = [];

  if (platform === "win32") {
    const pf         = process.env["ProgramFiles"]      || "C:\\Program Files";
    const pfx86      = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"]    || path.join(os.homedir(), "AppData", "Local");
    // Also try registry for non-standard installs
    try {
      const { execSync } = require("child_process");
      const reg = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const m = reg.match(/REG_SZ\s+(.+)/);
      if (m && fs.existsSync(m[1].trim())) candidates.push(m[1].trim());
    } catch {}
    candidates.push(
      path.join(pf,          "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx86,       "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData,"Google", "Chrome", "Application", "chrome.exe"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────
// PORT + READINESS HELPERS
// ─────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function fetchDebugInfo(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 1000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

async function waitForDebugPort(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = await fetchDebugInfo(port);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome debug port ${port} did not become ready in ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────
// STALE LOCK CLEANUP
// ─────────────────────────────────────────────────
function clearStaleProfileLocks(profileDir) {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
}

// ─────────────────────────────────────────────────
// LAUNCH
// ─────────────────────────────────────────────────
async function launchChrome(onLog, profileKey, launchMinimized) {
  const profileDir = getProfileDir(profileKey);
  const chromePath = findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Could not find Google Chrome on this system. Please install Chrome from https://www.google.com/chrome/"
    );
  }

  try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}

  onLog({ type: "info", msg: `🌐 Launching real Chrome via CDP attach...` });
  onLog({ type: "info", msg: `📁 Profile : ${profileDir}` });
  onLog({ type: "info", msg: `🧭 Binary  : ${chromePath}` });

  clearStaleProfileLocks(profileDir);

  const port = await getFreePort();
  spawnedChromePort = port;

  // ── CHROME FLAGS ──
  // Only flags that real Chrome uses silently with NO banners.
  // Removed: --use-mock-keychain, --password-store=basic, --metrics-recording-only,
  //          --no-service-autorun, --disable-extensions-except= (all cause warnings)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    // Startup behaviour (safe, no banners)
    "--no-first-run",
    "--no-default-browser-check",
    // Performance / stability (safe, no banners)
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    // Startup speed
    "--disk-cache-size=52428800",
    "--no-pings",
    "--disable-background-timer-throttling",
    // UI
    "--window-size=1280,800",
    "--disable-infobars",
    "--disable-notifications",
  ];

  const child = spawn(chromePath, args, { detached: false, stdio: "ignore" });
  spawnedChromeProcess = child;

  child.on("exit", (code) => {
    onLog({ type: "info", msg: `🛑 Chrome process exited (code ${code})` });
    if (spawnedChromeProcess === child) {
      spawnedChromeProcess = null;
      spawnedChromePort    = null;
    }
  });

  child.on("error", (err) => {
    onLog({ type: "error", msg: `💥 Failed to spawn Chrome: ${err.message}` });
  });

  onLog({ type: "info", msg: `⏳ Waiting for Chrome debug port ${port}...` });
  try {
    const info = await waitForDebugPort(port, 30000);
    onLog({ type: "ok", msg: `✅ Chrome ready (${info.Browser})` });
  } catch (e) {
    try { child.kill("SIGKILL"); } catch {}
    spawnedChromeProcess = null;
    spawnedChromePort    = null;
    throw new Error(`Chrome failed to expose debug port: ${e.message}`);
  }

  // Connect Playwright via CDP — the key anti-detection move.
  const browser  = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const context  = contexts[0] || (await browser.newContext());

  context.__adspyCdpBrowser = browser;
  context.__adspyChildProc  = child;
  context.__adspyPort       = port;

  // Skip ALL internal Chrome pages — only pick a real navigable tab
  function isNavigablePage(p) {
    const u = p.url() || "";
    return (
      u !== "" &&
      !u.startsWith("devtools://") &&
      !u.startsWith("chrome-extension://") &&
      !u.startsWith("chrome://") &&
      !u.startsWith("about:")
    );
  }

  let page = null;

  // Poll up to 5 seconds for a navigable page
  for (let i = 0; i < 50; i++) {
    const found = context.pages().find(isNavigablePage);
    if (found) { page = found; break; }
    await new Promise((r) => setTimeout(r, 100));
  }

  // No navigable page — open a fresh tab
  if (!page) {
    onLog({ type: "info", msg: "📄 No navigable tab found — opening a new tab" });
    page = await context.newPage();
    await page.waitForTimeout(500);
  }

  try { await page.bringToFront(); } catch {}

  // ── Minimize Chrome window via CDP if launchMinimized is enabled ──
  // Same pattern as KHOD — minimized so the bot runs silently in background.
  if (launchMinimized) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
      await cdp.detach();
      onLog({ type: "info", msg: "🪟 Chrome window minimized (Launch Minimized is ON)" });
    } catch (e) {
      onLog({ type: "info", msg: `ℹ️ Could not minimize Chrome window: ${e.message}` });
    }
  }

  const pageUrl = page.url() || "(empty)";
  onLog({
    type: "info",
    msg:  `📄 Active tab: ${pageUrl.slice(0, 80)} (${context.pages().length} total tab(s))`,
  });

  // Light webdriver guard — cheap insurance against bot-detection scripts
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        delete window.__PW_inspect;
        Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      } catch {}
    });
  } catch {}

  page.on("crash", () => onLog({ type: "error", msg: "💥 Page crashed" }));

  onLog({ type: "ok", msg: "✅ Chrome attached via CDP — anti-detection mode active" });
  onLog({
    type: "info",
    msg:  "ℹ️ First run? Log into TikTok Ads Manager in this window once. " +
          "Your session is saved to the profile and persists — no more logins.",
  });
  return { context, page };
}

// ─────────────────────────────────────────────────
// CLOSE — graceful shutdown so Chrome flushes cookies to disk
// ─────────────────────────────────────────────────
async function closeChrome(context, onLog) {
  const port  = (context && context.__adspyPort) || spawnedChromePort;
  const child = (context && context.__adspyChildProc) || spawnedChromeProcess;

  // Step 1 — disconnect Playwright CDP client (non-destructive)
  try {
    const browser = context && context.__adspyCdpBrowser;
    if (browser) await browser.disconnect().catch(() => {});
  } catch {}

  // Step 2 — close all tabs via DevTools HTTP API so Chrome flushes cookies
  if (port) {
    try {
      const tabList = await new Promise((resolve) => {
        http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 2000 }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
        }).on("error", () => resolve([]));
      });
      for (const tab of tabList) {
        if (tab.id) {
          await new Promise((resolve) => {
            http.get({ host: "127.0.0.1", port, path: `/json/close/${tab.id}`, timeout: 1000 }, () => resolve())
              .on("error", () => resolve());
          });
        }
      }
      // Give Chrome time to process the close requests and write session data
      await new Promise((r) => setTimeout(r, 2000));
    } catch {}
  }

  if (!child || child.killed || child.exitCode !== null) {
    spawnedChromeProcess = null;
    spawnedChromePort    = null;
    onLog({ type: "info", msg: "🔒 Browser closed" });
    return;
  }

  // Step 3 — polite termination (graceful WM_CLOSE on Windows)
  try {
    if (process.platform === "win32") {
      require("child_process").execSync(`taskkill /pid ${child.pid} /T`, { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {}

  // Step 4 — wait up to 8 seconds for Chrome to exit cleanly
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.killed || child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // Step 5 — force-kill only if still alive after the wait
  if (!child.killed && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        require("child_process").execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
  }

  spawnedChromeProcess = null;
  spawnedChromePort    = null;
  onLog({ type: "info", msg: "🔒 Browser closed" });
}

async function forceRefreshSession(onLog) {
  onLog({ type: "info", msg: "🔄 Opening Chrome for TikTok re-login..." });
  const { context, page } = await launchChrome(onLog, "tiktok-shared", false);
  try {
    await page.goto("https://ads.tiktok.com/i18n/login/", { waitUntil: "domcontentloaded" });
    onLog({
      type: "info",
      msg:  "👆 Please log into TikTok in the browser window. Solve the puzzle if shown. " +
            "When you see the Ads Manager dashboard you can close this window — your session is saved.",
    });
    await page.waitForURL((url) => url.includes("aadvid="), { timeout: 10 * 60 * 1000 });
    onLog({ type: "ok", msg: "✅ Logged in — session saved to profile" });
  } catch (e) {
    onLog({ type: "warn", msg: `⚠️ Re-login flow ended: ${e.message}` });
  } finally {
    await closeChrome(context, onLog);
  }
}

module.exports = {
  launchChrome,
  closeChrome,
  forceRefreshSession,
  getProfileDir,
};
