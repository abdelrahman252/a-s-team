/**
 * browser.js — Fast Chrome launch via Playwright launchPersistentContext
 *
 * STRATEGY
 * --------
 *   1. launchPersistentContext — Playwright's native persistent profile launch.
 *      2-5x faster than the old manual spawn+CDP attach.
 *
 *   2. ignoreDefaultArgs: ["--enable-automation"] removes the banner.
 *
 *   3. waitForInitialPage: false — don't wait for blank tab before returning.
 *
 *   4. Persistent profile per key means login cookies survive across runs.
 *
 *   5. Spoof navigator.webdriver via addInitScript.
 *
 *   6. Launch timeout: 20 s cap so a hung Chrome doesn't stall forever.
 */

const { chromium } = require("playwright-core");
const path  = require("path");
const os    = require("os");
const fs    = require("fs");

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
    const pf           = process.env["ProgramFiles"]      || "C:\\Program Files";
    const pfx86        = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"]      || path.join(os.homedir(), "AppData", "Local");
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
// LAUNCH — fast path via launchPersistentContext
// ─────────────────────────────────────────────────
async function launchChrome(onLog, profileKey, launchMinimized) {
  const profileDir = getProfileDir(profileKey);
  const chromePath = findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Could not find Google Chrome. Please install it from https://www.google.com/chrome/"
    );
  }

  try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
  clearStaleProfileLocks(profileDir);

  onLog({ type: "info", msg: `🌐 Launching Chrome (fast mode)...` });
  onLog({ type: "info", msg: `📁 Profile : ${profileDir}` });
  onLog({ type: "info", msg: `🧭 Binary  : ${chromePath}` });

  // ── FAST LAUNCH via launchPersistentContext ──
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    timeout: 20000, // 20 s cap — don't hang forever if Chrome won't start

    // Remove --enable-automation banner
    ignoreDefaultArgs: ["--enable-automation"],

    // Keep sandbox — removing it triggers Chrome 120+ warning banner
    chromiumSandbox: true,

    // Don't wait for initial blank tab — saves ~300 ms
    waitForInitialPage: false,

    args: [
      // ── Startup behaviour ──
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",

      // ── Performance / stability ──
      "--disable-background-networking",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-hang-monitor",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--disable-translate",

      // ── Startup speed ──
      "--disk-cache-size=52428800",   // 50 MB cache — bot uses few unique URLs
      "--no-pings",                   // skip update check (~200 ms saved)
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-component-extensions-with-background-pages",
      "--disable-v8-idle-tasks",

      // ── Display ──
      "--force-device-scale-factor=1",
      "--window-size=1280,800",
      ...(launchMinimized ? ["--window-position=-32000,-32000"] : []),
      "--disable-infobars",
      "--disable-notifications",

      // ── Locale — force Gregorian calendar on Arabic OS ──
      "--lang=en-US",
      "--accept-lang=en-US,en",
    ],

    locale: "en-US",
  });

  // ── Spoof browser fingerprint on every page before any JS runs ──
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
      delete window.__playwright;
      delete window.__pw_manual;
      delete window.__PW_inspect;
      Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
    } catch {}
  });

  const page = context.pages()[0] || (await context.newPage());

  // ── Minimize via CDP if requested ──
  if (launchMinimized) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: "normal" },
      });
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
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
// CLOSE — graceful, flushes cookies to disk
// ─────────────────────────────────────────────────
async function closeChrome(context, onLog) {
  try {
    if (context) await context.close();
  } catch {}
  onLog({ type: "info", msg: "🔒 Browser closed" });
}

async function forceRefreshSession(onLog) {
  onLog({ type: "info", msg: "🔄 Opening Chrome for TikTok re-login..." });
  const { context, page } = await launchChrome(onLog, "tiktok-shared", false);
  try {
    await page.goto("https://ads.tiktok.com/i18n/login/", { waitUntil: "domcontentloaded" });
    onLog({
      type: "info",
      msg:  "👆 Please log into TikTok in the browser window. When you see the Ads Manager dashboard, your session is saved.",
    });
    await page.waitForURL((url) => url.includes("aadvid="), { timeout: 10 * 60 * 1000 });
    onLog({ type: "ok", msg: "✅ Logged in — session saved to profile" });
  } catch (e) {
    onLog({ type: "warn", msg: `⚠️ Re-login flow ended: ${e.message}` });
  } finally {
    await closeChrome(context, onLog);
  }
}

module.exports = { launchChrome, closeChrome, forceRefreshSession, getProfileDir };
