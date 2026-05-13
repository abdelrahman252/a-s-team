/**
 * browser.js — Fast Chrome launch via Playwright launchPersistentContext
 *
 * KILL SWITCH:
 * ────────────
 *  Every opened context is registered in `openContexts`.
 *  When killAllChrome() is called (from runner.js on stop),
 *  every live Chrome is force-closed instantly — no waiting
 *  for the current scrape step to finish.
 *
 * SEQUENTIAL SAFETY:
 * ──────────────────
 *  600ms settle after close so the OS releases the SingletonLock
 *  before the next sequential TikTok launch touches the profile.
 *  On kill, we skip the settle — speed is the priority.
 *
 * STALE LOCK RETRY:
 * ─────────────────
 *  If Chrome says "Opening in existing browser session", we clear
 *  locks and retry once after 2s before giving up.
 */

const { chromium } = require("playwright-core");
const path = require("path");
const os   = require("fs");
const fs   = require("fs");

// ─────────────────────────────────────────────────
// KILL SWITCH — track every open context globally
// ─────────────────────────────────────────────────
const openContexts = new Set();

async function killAllChrome(onLog) {
  const log = onLog || (() => {});
  log({ type: "warn", msg: `⏹ Kill switch — closing ${openContexts.size} Chrome instance(s) immediately...` });
  const all = [...openContexts];
  openContexts.clear();
  await Promise.allSettled(all.map(ctx => ctx.close().catch(() => {})));
  log({ type: "ok", msg: "⏹ All Chrome instances closed." });
}

// ─────────────────────────────────────────────────
// PATHS
// ─────────────────────────────────────────────────
function getProfileDir(profileKey) {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "browser-profiles", profileKey || "default");
  } catch {
    return path.join(require("os").homedir(), `.as-team-${profileKey || "default"}`);
  }
}

function findChromeExecutable() {
  const platform = process.platform;
  const candidates = [];

  if (platform === "win32") {
    const pf           = process.env["ProgramFiles"]      || "C:\\Program Files";
    const pfx86        = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"]      || path.join(require("os").homedir(), "AppData", "Local");
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
    throw new Error("Could not find Google Chrome. Please install it from https://www.google.com/chrome/");
  }

  try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
  clearStaleProfileLocks(profileDir);

  onLog({ type: "info", msg: `🌐 Launching Chrome (fast mode)...` });
  onLog({ type: "info", msg: `📁 Profile : ${profileDir}` });
  onLog({ type: "info", msg: `🧭 Binary  : ${chromePath}` });

  const LAUNCH_OPTS = {
    executablePath: chromePath,
    headless: false,
    timeout: 20000,
    ignoreDefaultArgs: ["--enable-automation"],
    chromiumSandbox: true,
    waitForInitialPage: false,
    args: [
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-hang-monitor",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--disable-translate",
      "--disk-cache-size=52428800",
      "--no-pings",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-component-extensions-with-background-pages",
      "--disable-v8-idle-tasks",
      "--force-device-scale-factor=1",
      "--window-size=1280,800",
      ...(launchMinimized ? ["--window-position=-32000,-32000"] : []),
      "--disable-infobars",
      "--disable-notifications",
      "--lang=en-US",
      "--accept-lang=en-US,en",
    ],
    locale: "en-US",
  };

  // Retry once on session conflict / stale lock
  let context;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      context = await chromium.launchPersistentContext(profileDir, LAUNCH_OPTS);
      break;
    } catch (err) {
      const isConflict =
        (err.message || "").toLowerCase().includes("existing browser session") ||
        (err.message || "").toLowerCase().includes("target page, context or browser has been closed");
      if (isConflict && attempt === 1) {
        onLog({ type: "warn", msg: `⚠️ Chrome session conflict — clearing locks and retrying in 2s...` });
        clearStaleProfileLocks(profileDir);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }

  // Register in kill-switch set
  openContexts.add(context);
  context.on("close", () => openContexts.delete(context));

  // Anti-detection
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      delete window.__playwright;
      delete window.__pw_manual;
      delete window.__PW_inspect;
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    } catch {}
  });

  const page = context.pages()[0] || (await context.newPage());

  if (launchMinimized) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: "normal" } });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      await cdp.detach();
      onLog({ type: "ok", msg: "🪟 Chrome window minimized (Launch Minimized is ON)" });
    } catch (e) {
      onLog({ type: "info", msg: `⚠️ Could not minimize Chrome window: ${e.message}` });
    }
  } else {
    try { await page.bringToFront(); } catch {}
  }

  onLog({ type: "ok", msg: "✅ Chrome ready — anti-detection active" });
  return { context, page };
}

// ─────────────────────────────────────────────────
// CLOSE — graceful + 600ms OS settle
// ─────────────────────────────────────────────────
async function closeChrome(context, onLog) {
  openContexts.delete(context);
  try { if (context) await context.close(); } catch {}
  // Give OS time to release the SingletonLock before the next launch
  await new Promise(r => setTimeout(r, 600));
  onLog({ type: "info", msg: "🔒 Browser closed" });
}

// ─────────────────────────────────────────────────
// FORCE REFRESH SESSION (manual re-login flow)
// ─────────────────────────────────────────────────
async function forceRefreshSession(onLog) {
  onLog({ type: "info", msg: "🔄 Opening Chrome for TikTok re-login..." });
  const { context, page } = await launchChrome(onLog, "tiktok-shared", false);
  try {
    await page.goto("https://ads.tiktok.com/i18n/login/", { waitUntil: "domcontentloaded" });
    onLog({ type: "info", msg: "👆 Please log into TikTok. When you see the Ads Manager dashboard, your session is saved." });
    await page.waitForURL((url) => url.includes("aadvid="), { timeout: 10 * 60 * 1000 });
    onLog({ type: "ok", msg: "✅ Logged in — session saved to profile" });
  } catch (e) {
    onLog({ type: "warn", msg: `⚠️ Re-login flow ended: ${e.message}` });
  } finally {
    await closeChrome(context, onLog);
  }
}

module.exports = { launchChrome, closeChrome, killAllChrome, forceRefreshSession, getProfileDir };
