"use strict";

/**
 * tiktok.js — TikTok Ads spend scraper
 *
 * CHROME MODEL (v2):
 * ──────────────────
 *  Each TikTok account ID gets its OWN Chrome launch → scrape → close.
 *  No shared page, no mutex, no race conditions.
 *  Clean slate every time — TikTok can't get confused between accounts.
 *  Session cookies are preserved via the persistent profile "tiktok-shared"
 *  so login survives across launches.
 *
 * WAIT-FOR-TABLE STRATEGY:
 * ────────────────────────
 *  "—" (dash) = page still loading. NEVER treat as zero.
 *  "0.00 SAR"  = real zero. Only accept when currency symbol is present.
 *  We poll until we see an actual number WITH a currency symbol (SAR/USD/EGP/AED).
 *  Only after full timeout (35s) with no currency found do we give up.
 *
 * SHADOW DOM STRATEGY — NO SUFFIX SELECTORS EVER:
 * ─────────────────────────────────────────────────
 *  TikTok's component suffix (e.g. -1-1-14, -1-1-19) changes between accounts
 *  and deployments. ALL selectors use suffix-free approaches only.
 */

const { launchChrome, closeChrome } = require("./browser");

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];

function lg(onLog, type, msg) { onLog({ type, msg }); }

function parseSpend(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, "").match(/[\d]+\.?\d*/);
  const v = m ? parseFloat(m[0]) : 0;
  return isNaN(v) ? 0 : v;
}

// ════════════════════════════════════════════════════════
// SESSION HELPERS
// ════════════════════════════════════════════════════════

function isLoginUrl(url) {
  if (!url || url === "about:blank" || url.startsWith("chrome://")) return false;
  return url.includes("/login") || url.includes("/auth") ||
         url.includes("redirect=") || !url.includes("ads.tiktok.com");
}

async function ensureSession(page, onLog, contextLabel) {
  if (!isLoginUrl(page.url())) return true;
  lg(onLog, "warn", `⚠️ [${contextLabel}] Session expired — on login page`);
  lg(onLog, "warn", `👆 [${contextLabel}] Please log in (up to 10 min)...`);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!isLoginUrl(page.url())) {
      lg(onLog, "ok", `✅ [${contextLabel}] Login confirmed — resuming`);
      return true;
    }
  }
  throw new Error(`[${contextLabel}] TikTok login timeout`);
}

async function confirmInitialLogin(page, onLog) {
  lg(onLog, "info", "🔑 Checking TikTok session...");
  await page.goto("https://ads.tiktok.com/i18n/dashboard", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  if (!isLoginUrl(page.url())) {
    lg(onLog, "ok", "✅ Already logged in — skipping login");
    return;
  }
  await ensureSession(page, onLog, "initial login");
}

// ════════════════════════════════════════════════════════
// OPEN DATE PICKER
// ════════════════════════════════════════════════════════

async function openDatePicker(page, onLog) {
  lg(onLog, "info", "   🗓️  Opening date picker...");

  let clicked = await page.evaluate(() => {
    function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName && el.tagName.toLowerCase().includes("display-field") && el.shadowRoot) {
          const btn = el.shadowRoot.querySelector("button");
          if (btn) { btn.click(); return true; }
        }
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return false;
    }
    return walk(document);
  });
  lg(onLog, "info", `   🗓️  Try 1 (display-field tag): ${clicked}`);

  if (!clicked) {
    clicked = await page.evaluate(() => {
      function walk(root) {
        for (const el of root.querySelectorAll("[data-testid*='display-field']")) {
          if (el.shadowRoot) { const btn = el.shadowRoot.querySelector("button"); if (btn) { btn.click(); return true; } }
          el.click(); return true;
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return false;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Try 2 (display-field testid): ${clicked}`);
  }

  if (!clicked) {
    clicked = await page.evaluate(() => {
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const btn = el.shadowRoot.querySelector("button");
            if (btn && /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(btn.textContent || "") && (btn.textContent || "").length < 60) {
              btn.click(); return true;
            }
            const r = walk(el.shadowRoot);
            if (r) return r;
          }
        }
        return false;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Try 3 (shadow month-text button): ${clicked}`);
  }

  if (!clicked) {
    clicked = await page.evaluate(() => {
      const el = document.querySelector("[class*='picker--'], [class*='KsDateRange']");
      if (el) { el.click(); return true; }
      return false;
    });
    lg(onLog, "info", `   🗓️  Try 4 (picker class): ${clicked}`);
  }

  await page.waitForTimeout(300);

  const calOpen = await page.evaluate(() => {
    function walk(root) {
      if (root.querySelector(".date-grid-body__date-item")) return true;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
      }
      return false;
    }
    return walk(document);
  });
  lg(onLog, calOpen ? "ok" : "warn", `   🗓️  Calendar open: ${calOpen}`);
  return calOpen;
}

// ════════════════════════════════════════════════════════
// GET CURRENT MONTH/YEAR
// ════════════════════════════════════════════════════════

async function getCurrentMonthYear(page) {
  return page.evaluate(() => {
    const MONTHS = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
    function walk(root) {
      const btns = root.querySelectorAll("button.date-grid-header__labels-part--clickable");
      if (btns.length >= 2) {
        const month = btns[0].textContent.trim();
        const year  = parseInt(btns[1].textContent.trim());
        const mi    = MONTHS.indexOf(month);
        if (mi >= 0 && !isNaN(year)) return { monthIdx: mi, year, monthName: month };
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return null;
    }
    return walk(document);
  });
}

// ════════════════════════════════════════════════════════
// NAVIGATE TO TARGET MONTH
// ════════════════════════════════════════════════════════

async function navigateToMonth(page, targetYear, targetMonth, onLog) {
  for (let i = 0; i < 24; i++) {
    const cur = await getCurrentMonthYear(page);
    if (!cur) { lg(onLog, "warn", "   🗓️  Could not read current month"); break; }
    lg(onLog, "info", `   🗓️  Calendar shows: ${cur.monthName} ${cur.year} → want: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
    if (cur.year === targetYear && cur.monthIdx === targetMonth) break;

    const curTotal    = cur.year * 12 + cur.monthIdx;
    const targetTotal = targetYear * 12 + targetMonth;
    const goBack      = targetTotal < curTotal;

    const moved = await page.evaluate((goBack) => {
      const iconTag = goBack ? "ks-icon-chevron-left" : "ks-icon-chevron-right";
      function tryInHeaderShadow(shadow) {
        const groups = shadow.querySelectorAll(".date-grid-header__controls");
        for (const group of groups) {
          if (group.classList.contains("date-grid-header__controls--hidden")) continue;
          const icon = group.querySelector(iconTag);
          if (!icon) continue;
          const wrapper = icon.closest("[class*='KsIconButton']");
          if (wrapper && wrapper.shadowRoot) {
            const btn = wrapper.shadowRoot.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
          let node = icon.parentElement;
          while (node) {
            if (node.shadowRoot) { const btn = node.shadowRoot.querySelector("button"); if (btn) { btn.click(); return true; } }
            node = node.parentElement;
          }
          icon.click(); return true;
        }
        return false;
      }
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.tagName && el.tagName.toLowerCase().includes("date-grid-header") && el.shadowRoot) {
            if (tryInHeaderShadow(el.shadowRoot)) return true;
            if (walk(el.shadowRoot)) return true;
          } else if (el.shadowRoot) {
            if (walk(el.shadowRoot)) return true;
          }
        }
        return false;
      }
      return walk(document);
    }, goBack);

    lg(onLog, "info", `   🗓️  Navigate ${goBack ? "←" : "→"}: ${moved}`);
    await page.waitForTimeout(200);
  }
}

// ════════════════════════════════════════════════════════
// CLICK A SPECIFIC DAY
// ════════════════════════════════════════════════════════

async function clickDay(page, day, targetMonth, targetYear, onLog) {
  const dayStr = String(day);
  lg(onLog, "info", `   🗓️  Clicking day ${dayStr} (${MONTH_NAMES[targetMonth]} ${targetYear})...`);

  let clicked = await page.evaluate((dayStr) => {
    function walk(root) {
      const items = root.querySelectorAll(".date-grid-body__date-item");
      for (const item of items) {
        const t = item.textContent.trim();
        const cls = item.className || "";
        if (t === dayStr && !cls.includes("outside-current-period")) { item.click(); return true; }
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return false;
    }
    return walk(document);
  }, dayStr);
  lg(onLog, "info", `   🗓️  Day click try 1 (class+text): ${clicked}`);

  if (!clicked) {
    clicked = await page.evaluate((dayStr) => {
      function walk(root) {
        const items = root.querySelectorAll(`[data-testid$="-${dayStr}"]`);
        for (const item of items) {
          const cls = item.className || "";
          if (!cls.includes("outside-current-period") && !cls.includes("decorative")) { item.click(); return true; }
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return false;
      }
      return walk(document);
    }, dayStr);
    lg(onLog, "info", `   🗓️  Day click try 2 (data-testid): ${clicked}`);
  }

  await page.waitForTimeout(150);
  return clicked;
}

// ════════════════════════════════════════════════════════
// CLICK CONFIRM
// ════════════════════════════════════════════════════════

async function clickConfirm(page, onLog) {
  lg(onLog, "info", "   🗓️  Clicking Confirm...");

  let clicked = await page.evaluate(() => {
    function findFooter(root) {
      const el = root.querySelector(".picker-core__popup-footer-append");
      if (el) return el;
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const r = findFooter(c.shadowRoot); if (r) return r; }
      }
      return null;
    }
    const footer = findFooter(document);
    if (!footer) return "no-footer";
    for (const el of footer.querySelectorAll("[class*='KsButton']")) {
      if ((el.textContent || "").trim() === "Confirm") {
        const btn = el.shadowRoot ? el.shadowRoot.querySelector("button") : null;
        if (btn) { btn.click(); return "ksbutton-shadow"; }
        el.click(); return "ksbutton-host";
      }
    }
    for (const btn of footer.querySelectorAll("button")) {
      if ((btn.textContent || "").trim() === "Confirm") { btn.click(); return "plain-button"; }
    }
    return null;
  });
  lg(onLog, "info", `   🗓️  Confirm try 1: ${clicked}`);
  if (clicked && clicked !== "no-footer") { await page.waitForTimeout(500); return; }

  clicked = await page.evaluate(() => {
    function findPopup(root) {
      const el = root.querySelector(".picker-core__popup");
      if (el) return el;
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const r = findPopup(c.shadowRoot); if (r) return r; }
      }
      return null;
    }
    function findConfirm(root) {
      for (const el of root.querySelectorAll("[class*='KsButton']")) {
        if ((el.textContent || "").trim() === "Confirm") {
          const btn = el.shadowRoot ? el.shadowRoot.querySelector("button") : null;
          if (btn) { btn.click(); return "popup-ksbutton-shadow"; }
          el.click(); return "popup-ksbutton-host";
        }
      }
      for (const btn of root.querySelectorAll("button")) {
        if ((btn.textContent || "").trim() === "Confirm") { btn.click(); return "popup-plain-btn"; }
      }
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const r = findConfirm(c.shadowRoot); if (r) return r; }
      }
      return null;
    }
    const popup = findPopup(document);
    if (!popup) return "no-popup";
    return findConfirm(popup);
  });
  lg(onLog, "info", `   🗓️  Confirm try 2: ${clicked}`);
  if (clicked && clicked !== "no-popup") { await page.waitForTimeout(500); return; }

  clicked = await page.evaluate(() => {
    function insidePickerPopup(el) {
      let node = el;
      while (node) {
        if (node.classList && (
          node.classList.contains("picker-core__popup") ||
          node.classList.contains("picker-core__popup-footer") ||
          node.classList.contains("picker-core__popup-footer-append")
        )) return true;
        node = node.parentElement || (node.getRootNode ? node.getRootNode().host : null);
      }
      return false;
    }
    function walk(root) {
      for (const el of root.querySelectorAll("[class*='KsButton']")) {
        if ((el.textContent || "").trim() !== "Confirm") continue;
        if (!insidePickerPopup(el)) continue;
        const btn = el.shadowRoot ? el.shadowRoot.querySelector("button") : null;
        if (btn) { btn.click(); return "global-scoped-shadow"; }
        el.click(); return "global-scoped-host";
      }
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const r = walk(c.shadowRoot); if (r) return r; }
      }
      return null;
    }
    return walk(document);
  });
  lg(onLog, "info", `   🗓️  Confirm try 3: ${clicked}`);
  if (clicked) { await page.waitForTimeout(500); return; }

  lg(onLog, "warn", "   🗓️  ⚠️  All Confirm tries failed — date may not be applied");
  await page.waitForTimeout(500);
}

// ════════════════════════════════════════════════════════
// SET DATE RANGE
// ════════════════════════════════════════════════════════

async function setDateRange(page, dateFrom, dateTo, onLog) {
  const fY = dateFrom.getFullYear(), fM = dateFrom.getMonth(), fD = dateFrom.getDate();
  const tY = dateTo.getFullYear(),   tM = dateTo.getMonth(),   tD = dateTo.getDate();
  const isSame = fY===tY && fM===tM && fD===tD;

  lg(onLog, "info", `📅 Setting date: ${MONTH_NAMES[fM]} ${fD} ${fY}${isSame ? " (single)" : " → " + MONTH_NAMES[tM] + " " + tD + " " + tY}`);

  const opened = await openDatePicker(page, onLog);
  if (!opened) lg(onLog, "warn", "⚠️ Calendar may not have opened — continuing anyway");
  await page.waitForTimeout(200);

  await navigateToMonth(page, fY, fM, onLog);
  await page.waitForTimeout(150);
  await clickDay(page, fD, fM, fY, onLog);
  await page.waitForTimeout(150);

  if (isSame) {
    lg(onLog, "info", `   🗓️  Single date — clicking day ${fD} again for TO...`);
    await clickDay(page, fD, fM, fY, onLog);
  } else {
    await navigateToMonth(page, tY, tM, onLog);
    await page.waitForTimeout(150);
    await clickDay(page, tD, tM, tY, onLog);
  }
  await page.waitForTimeout(150);

  await clickConfirm(page, onLog);
  lg(onLog, "ok", "✅ Date range set and confirmed");
  await page.waitForTimeout(500);
}

// ════════════════════════════════════════════════════════
// WAIT FOR TABLE — SMART VERSION
//
// THE RULE:
//   "—" (dash) → page is STILL LOADING → keep waiting
//   "0.00 SAR" → real zero, page done → accept it
//   "1,234 SAR" → has spend → accept it
//
// We only trust the value once a currency symbol appears.
// Timeout is 35 seconds. After that, one last full-page scan.
// ════════════════════════════════════════════════════════

async function waitForTable(page, ms, onLog) {
  lg(onLog, "info", "   💰 Waiting for real value (SAR/currency) in spend slot...");
  const start = Date.now();

  while (Date.now() - start < ms) {
    if (isLoginUrl(page.url())) {
      lg(onLog, "warn", "   ⚠️ Redirected to login while waiting for table");
      return { status: "login" };
    }

    const found = await page.evaluate(() => {
      const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;

      function getSpendText(root) {
        // Primary: the named footer slot for spend
        const slot = root.querySelector('[slot="footer-stat_cost"]');
        if (slot) {
          const t = slot.textContent?.trim();
          if (t) return t;
        }
        // Walk shadow roots
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const t = getSpendText(el.shadowRoot);
            if (t) return t;
          }
        }
        return null;
      }

      const text = getSpendText(document);
      if (!text) return { ready: false, text: null, reason: "slot-missing" };

      // Currency found = table fully loaded
      if (CURRENCY_RE.test(text)) return { ready: true, text };

      // Still a dash or spinner = still loading
      return { ready: false, text, reason: "no-currency-yet" };
    });

    if (found.ready) {
      lg(onLog, "ok", `   💰 Table loaded ✅  value: "${found.text}"`);
      return { status: "ready", text: found.text };
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    lg(onLog, "info", `   💰 Still loading... slot="${found.text || "empty"}" (${elapsed}s elapsed)`);
    await page.waitForTimeout(800);
  }

  lg(onLog, "warn", `   💰 ${ms/1000}s timeout — no currency value appeared in slot`);
  return { status: "timeout" };
}

// ════════════════════════════════════════════════════════
// READ SPEND
// ════════════════════════════════════════════════════════

async function readSpend(page, onLog) {
  const tableResult = await waitForTable(page, 35000, onLog);

  if (tableResult.status === "login") return "SESSION_EXPIRED";

  if (tableResult.status === "timeout") {
    // Last-ditch: scan whole page for any leaf element with a currency value
    lg(onLog, "info", "   💰 Last-ditch full-page currency scan...");
    const fallback = await page.evaluate(() => {
      const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          const t = el.textContent?.trim() || "";
          if (CURRENCY_RE.test(t) && el.children.length === 0) return t;
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      return walk(document);
    });
    if (fallback) {
      lg(onLog, "ok", `   💰 Last-ditch found: "${fallback}"`);
      return parseSpend(fallback);
    }
    lg(onLog, "warn", "   💰 Nothing found — returning 0");
    return 0;
  }

  return parseSpend(tableResult.text);
}

// ════════════════════════════════════════════════════════
// WAIT FOR CAMPAIGNS PAGE
// ════════════════════════════════════════════════════════

async function waitForCampaignsPage(page, aadvid, onLog) {
  lg(onLog, "info", `   🌐 Waiting for campaigns page (aadvid: ${aadvid})...`);
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    if (isLoginUrl(url)) {
      lg(onLog, "warn", "   ⚠️ TikTok redirected to login — session expired");
      await ensureSession(page, onLog, `account ${aadvid || "?"}`);
      return false;
    }
    if (Date.now() - lastLog > 5000) {
      lg(onLog, "info", `   🌐 URL: ${url.slice(0, 90)}`);
      lastLog = Date.now();
    }
    if (!aadvid || url.includes(aadvid)) {
      const pickerFound = await page.evaluate(() => {
        function walk(root) {
          for (const el of root.querySelectorAll("*")) {
            if (el.tagName && el.tagName.toLowerCase().includes("display-field") && el.shadowRoot) {
              if (el.shadowRoot.querySelector("button")) return true;
            }
            if (el.shadowRoot && walk(el.shadowRoot)) return true;
          }
          return false;
        }
        return walk(document);
      });
      if (pickerFound) {
        lg(onLog, "ok", "   ✅ Campaigns page ready");
        return true;
      }
      lg(onLog, "info", "   🌐 On campaigns page but picker not ready yet...");
    }
    await page.waitForTimeout(2000);
  }
  lg(onLog, "warn", "   ⚠️ Campaigns page wait timed out — trying anyway");
  return true;
}

// ════════════════════════════════════════════════════════
// SCRAPE ONE ACCOUNT (reuses an already-open page)
// ════════════════════════════════════════════════════════

async function scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog) {
  lg(onLog, "info", `   🌐 Account entry: ${accountUrl.slice(0, 80)}`);

  let cleanUrl = accountUrl;
  let aadvid = null;
  try {
    const trimmed = accountUrl.trim();
    if (/^\d+$/.test(trimmed)) {
      aadvid   = trimmed;
      cleanUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`;
    } else {
      const u = new URL(trimmed);
      aadvid   = u.searchParams.get("aadvid");
      cleanUrl = aadvid
        ? `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`
        : trimmed;
    }
    lg(onLog, "info", `   🌐 aadvid: ${aadvid} → ${cleanUrl}`);
  } catch (e) {
    lg(onLog, "warn", `   🌐 URL parse error: ${e.message}`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    lg(onLog, "info", `   🌐 Navigating... (attempt ${attempt + 1})`);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    if (isLoginUrl(page.url())) {
      lg(onLog, "warn", "   ⚠️ Redirected to login — recovering...");
      await ensureSession(page, onLog, `account ${aadvid || "?"}`);
      continue;
    }
    break;
  }

  await waitForCampaignsPage(page, aadvid, onLog);

  if (isLoginUrl(page.url())) {
    await ensureSession(page, onLog, `pre-scrape ${aadvid || "?"}`);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    await waitForCampaignsPage(page, aadvid, onLog);
  }

  await setDateRange(page, dateFrom, dateTo, onLog);

  // Guard: accidental navigation to campaign creation
  const postDateUrl = page.url();
  if (postDateUrl.includes("/creation/") || postDateUrl.includes("/create/campaign")) {
    lg(onLog, "warn", `   ⚠️ Accidental navigation to campaign creation! Recovering...`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    await waitForCampaignsPage(page, aadvid, onLog);
    await setDateRange(page, dateFrom, dateTo, onLog);
  }

  let spend = await readSpend(page, onLog);

  if (spend === "SESSION_EXPIRED") {
    lg(onLog, "warn", "   ⚠️ Session expired while reading spend — recovering...");
    await ensureSession(page, onLog, `spend-read ${aadvid || "?"}`);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    await waitForCampaignsPage(page, aadvid, onLog);
    await setDateRange(page, dateFrom, dateTo, onLog);
    spend = await readSpend(page, onLog);
    if (spend === "SESSION_EXPIRED") {
      lg(onLog, "warn", "   ⚠️ Spend still unreadable — using 0");
      spend = 0;
    }
  }

  lg(onLog, "ok", `   ✅ Spend: ${spend}`);
  return spend;
}

// ════════════════════════════════════════════════════════
// SCRAPE ONE ACCOUNT WITH ITS OWN CHROME
//
// Launch Chrome → check session → scrape → close Chrome.
// Each account is fully isolated. No shared state, no cracking.
// The persistent profile "tiktok-shared" keeps the login cookie
// alive between launches so you don't need to re-login each time.
// ════════════════════════════════════════════════════════

async function scrapeAccountWithOwnChrome(accountUrl, dateFrom, dateTo, onLog, launchMinimized) {
  const label = accountUrl.trim().slice(0, 50);
  lg(onLog, "info", `\n🚀 Launching Chrome for: ${label}`);

  const { context, page } = await launchChrome(onLog, "tiktok-shared", launchMinimized);
  try {
    await confirmInitialLogin(page, onLog);
    const spend = await scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog);
    return spend;
  } finally {
    lg(onLog, "info", `🔒 Closing Chrome for: ${label}`);
    await closeChrome(context, onLog);
  }
}

// ════════════════════════════════════════════════════════
// MAIN — per-member entry point
//
// Accounts scraped ONE BY ONE.
// Each gets: launch Chrome → scrape → close Chrome → next.
// ════════════════════════════════════════════════════════

async function runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized, cancelToken }) {
  const fromDate = new Date(dateFrom);
  const toDate   = new Date(dateTo || dateFrom);

  const accounts = (member.tiktokAccounts || []).filter(a => a && a.trim() !== "");
  if (accounts.length === 0) {
    lg(onLog, "warn", `⚠️ No TikTok accounts configured for ${member.name} — skipping`);
    return { success: true, memberId: member.id, totalSpend: 0 };
  }

  lg(onLog, "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lg(onLog, "info", `🎵 TikTok: ${member.name} — ${accounts.length} account(s)`);
  lg(onLog, "info", `   Mode: 1 account → own Chrome → close → next`);
  lg(onLog, "info", `   Date: ${fromDate.toDateString()} → ${toDate.toDateString()}`);

  try {
    let totalSpend = 0;

    for (let i = 0; i < accounts.length; i++) {
      if (cancelToken && cancelToken.cancelled) {
        lg(onLog, "warn", "⏹ Stop requested — TikTok stopping.");
        break;
      }

      lg(onLog, "info", `\n🎵 ── Account ${i + 1} of ${accounts.length} ──`);

      try {
        const spend = await scrapeAccountWithOwnChrome(
          accounts[i], fromDate, toDate, onLog, launchMinimized
        );
        const numeric = typeof spend === "number" ? spend : 0;
        totalSpend += numeric;
        lg(onLog, "ok", `🎵 Account ${i + 1}: ${numeric} | Running total: ${totalSpend}`);
      } catch (err) {
        lg(onLog, "warn", `⚠️ Account ${i + 1} failed: ${err.message} — using 0`);
      }
    }

    lg(onLog, "ok", `✅ TikTok total for ${member.name}: ${totalSpend}`);
    return { success: true, memberId: member.id, totalSpend };

  } catch (err) {
    lg(onLog, "error", `❌ TikTok fatal [${member.name}]: ${err.message}`);
    return { success: false, memberId: member.id, totalSpend: 0, error: err.message };
  }
}

module.exports = { runTikTok };
