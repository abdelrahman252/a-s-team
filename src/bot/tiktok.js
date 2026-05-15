"use strict";

/**
 * tiktok.js — TikTok Ads spend scraper
 *
 * CHROME MODEL:
 * ─────────────
 *  Each TikTok account gets its OWN Chrome: launch → scrape → close.
 *  All accounts run sequentially via runner.js global queue — only
 *  ONE Chrome ever touches "tiktok-shared" at a time. No race conditions.
 *  Session cookies survive across launches via the persistent profile.
 *
 * WAIT-FOR-TABLE STRATEGY:
 * ────────────────────────
 *  "—" (dash) = page still loading → keep waiting, NEVER treat as zero.
 *  "0.00 SAR"  = real zero, page done → accept it.
 *  We poll until a value WITH a currency symbol (SAR/USD/EGP/AED) appears.
 *  Timeout: 45s (up from 35s) then one last full-page fallback scan.
 *
 * SHADOW DOM — NO SUFFIX SELECTORS EVER:
 * ───────────────────────────────────────
 *  TikTok's component suffix (e.g. -1-1-14) changes between accounts
 *  and deployments. ALL selectors use suffix-free shadow-walk approaches.
 */

const { launchChrome, closeChrome } = require("./browser");

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;

function lg(onLog, type, msg) { onLog({ type, msg }); }

function parseSpend(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, "").match(/\d+\.?\d*/);
  const v = m ? parseFloat(m[0]) : 0;
  return isNaN(v) ? 0 : v;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isNavigationAbort(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("net::ERR_ABORTED") ||
    msg.includes("NS_BINDING_ABORTED")
  );
}

async function gotoWithRetry(page, url, onLog, label, opts = {}) {
  const attempts = opts.attempts || 3;
  const waitUntil = opts.waitUntil || "domcontentloaded";
  const timeout = opts.timeout || 45000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (err) {
      if (page.isClosed()) throw err;
      if (!isNavigationAbort(err) || attempt === attempts) throw err;

      lg(onLog, "warn", `   🌐 ${label} aborted (${attempt}/${attempts}) — retrying navigation...`);
      await sleep(900 * attempt);

      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
      } catch {}

      try {
        await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 });
      } catch {}

      await sleep(300);
    }
  }
}

// ════════════════════════════════════════════════════════
// SESSION HELPERS
// ════════════════════════════════════════════════════════

function isLoginUrl(url) {
  if (!url || url === "about:blank" || url.startsWith("chrome://")) return false;
  return (
    url.includes("/login") ||
    url.includes("/auth")  ||
    url.includes("redirect=") ||
    !url.includes("ads.tiktok.com")
  );
}

async function ensureSession(page, onLog, label) {
  if (!isLoginUrl(page.url())) return true;
  lg(onLog, "warn", `⚠️ [${label}] Session expired — on login page`);
  lg(onLog, "warn", `👆 [${label}] Please log in manually (up to 10 min)...`);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!isLoginUrl(page.url())) {
      lg(onLog, "ok", `✅ [${label}] Login confirmed — resuming`);
      return true;
    }
  }
  throw new Error(`[${label}] TikTok login timeout after 10 min`);
}

async function confirmInitialLogin(page, onLog) {
  lg(onLog, "info", "🔑 Checking TikTok session...");
  await gotoWithRetry(page, "https://ads.tiktok.com/i18n/dashboard", onLog, "Initial TikTok session check", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  // Wait for real signal instead of fixed sleep:
  // either we're past login OR a login form element appears
  await page.waitForFunction(
    () => !window.location.href.includes("/login") ||
          document.querySelector('input[type="password"]') !== null,
    { timeout: 4000 }
  ).catch(() => {});

  if (!isLoginUrl(page.url())) {
    lg(onLog, "ok", "✅ Already logged in — skipping login");
    return;
  }
  await ensureSession(page, onLog, "initial login");
}

// ════════════════════════════════════════════════════════
// OPEN DATE PICKER — 4 fallback strategies
// ════════════════════════════════════════════════════════

async function openDatePicker(page, onLog) {
  lg(onLog, "info", "   🗓️  Opening date picker...");

  // Try 1: display-field custom element → shadow button
  let clicked = await page.evaluate(() => {
    function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName?.toLowerCase().includes("display-field") && el.shadowRoot) {
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

  // Try 2: data-testid containing 'display-field'
  if (!clicked) {
    clicked = await page.evaluate(() => {
      function walk(root) {
        for (const el of root.querySelectorAll("[data-testid*='display-field']")) {
          if (el.shadowRoot) {
            const btn = el.shadowRoot.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
          el.click();
          return true;
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return false;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Try 2 (data-testid display-field): ${clicked}`);
  }

  // Try 3: shadow button whose text looks like a month abbreviation
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const MONTH_PAT = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/;
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const btn = el.shadowRoot.querySelector("button");
            if (btn && MONTH_PAT.test(btn.textContent || "") && (btn.textContent || "").length < 60) {
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

  // Try 4: any element with picker/KsDateRange class
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const el = document.querySelector("[class*='picker--'], [class*='KsDateRange']");
      if (el) { el.click(); return true; }
      return false;
    });
    lg(onLog, "info", `   🗓️  Try 4 (picker class): ${clicked}`);
  }

  // Wait for calendar DOM to appear (event-driven, not fixed sleep)
  await page.waitForFunction(() => {
    function walk(root) {
      if (root.querySelector(".date-grid-body__date-item")) return true;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
      }
      return false;
    }
    return walk(document);
  }, { timeout: 3000 }).catch(() => {});

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
// GET CURRENT MONTH/YEAR shown in calendar
// ════════════════════════════════════════════════════════

async function getCurrentMonthYear(page) {
  return page.evaluate(() => {
    const MONTHS = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    function walk(root) {
      const btns = root.querySelectorAll("button.date-grid-header__labels-part--clickable");
      if (btns.length >= 2) {
        const month = btns[0].textContent.trim();
        const year  = parseInt(btns[1].textContent.trim(), 10);
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
// NAVIGATE CALENDAR TO TARGET MONTH
// ════════════════════════════════════════════════════════

async function navigateToMonth(page, targetYear, targetMonth, onLog) {
  for (let i = 0; i < 24; i++) {
    const cur = await getCurrentMonthYear(page);
    if (!cur) { lg(onLog, "warn", "   🗓️  Could not read calendar month"); break; }
    lg(onLog, "info", `   🗓️  Calendar shows: ${cur.monthName} ${cur.year} → want: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
    if (cur.year === targetYear && cur.monthIdx === targetMonth) break;

    const goBack = (targetYear * 12 + targetMonth) < (cur.year * 12 + cur.monthIdx);

    const moved = await page.evaluate((goBack) => {
      const iconTag = goBack ? "ks-icon-chevron-left" : "ks-icon-chevron-right";
      function tryClick(shadow) {
        const groups = shadow.querySelectorAll(".date-grid-header__controls");
        for (const group of groups) {
          if (group.classList.contains("date-grid-header__controls--hidden")) continue;
          const icon = group.querySelector(iconTag);
          if (!icon) continue;
          const wrapper = icon.closest("[class*='KsIconButton']");
          if (wrapper?.shadowRoot) {
            const btn = wrapper.shadowRoot.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
          let node = icon.parentElement;
          while (node) {
            if (node.shadowRoot) {
              const btn = node.shadowRoot.querySelector("button");
              if (btn) { btn.click(); return true; }
            }
            node = node.parentElement;
          }
          icon.click();
          return true;
        }
        return false;
      }
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.tagName?.toLowerCase().includes("date-grid-header") && el.shadowRoot) {
            if (tryClick(el.shadowRoot)) return true;
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
    // Wait for calendar month to actually change (event-driven)
    await page.waitForFunction(
      (args) => {
        const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        function walk(root) {
          const btns = root.querySelectorAll("button.date-grid-header__labels-part--clickable");
          if (btns.length >= 2) {
            const m = MONTHS.indexOf(btns[0].textContent.trim());
            const y = parseInt(btns[1].textContent.trim(), 10);
            return m === args.targetMonth && y === args.targetYear;
          }
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot && walk(el.shadowRoot)) return true;
          }
          return false;
        }
        return walk(document);
      },
      { targetMonth, targetYear },
      { timeout: 1500 }
    ).catch(() => sleep(200));
  }
}

// ════════════════════════════════════════════════════════
// CLICK A SPECIFIC DAY
// ════════════════════════════════════════════════════════

async function clickDay(page, day, targetMonth, targetYear, onLog) {
  const dayStr = String(day);
  lg(onLog, "info", `   🗓️  Clicking day ${dayStr} (${MONTH_NAMES[targetMonth]} ${targetYear})...`);

  // Try 1: class-based selector
  let clicked = await page.evaluate((dayStr) => {
    function walk(root) {
      const items = root.querySelectorAll(".date-grid-body__date-item");
      for (const item of items) {
        if (item.textContent.trim() === dayStr && !item.className.includes("outside-current-period")) {
          item.click(); return true;
        }
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return false;
    }
    return walk(document);
  }, dayStr);
  lg(onLog, "info", `   🗓️  Day click try 1 (class+text): ${clicked}`);

  // Try 2: data-testid suffix
  if (!clicked) {
    clicked = await page.evaluate((dayStr) => {
      function walk(root) {
        const items = root.querySelectorAll(`[data-testid$="-${dayStr}"]`);
        for (const item of items) {
          const cls = item.className || "";
          if (!cls.includes("outside-current-period") && !cls.includes("decorative")) {
            item.click(); return true;
          }
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

  await sleep(150);
  return clicked;
}

// ════════════════════════════════════════════════════════
// CLICK CONFIRM — 3 fallback strategies
// ════════════════════════════════════════════════════════

async function clickConfirm(page, onLog) {
  lg(onLog, "info", "   🗓️  Clicking Confirm...");

  // Helper: find KsButton with "Confirm" text and click it
  const CONFIRM_FINDER = `
    function findAndClickConfirm(root) {
      for (const el of root.querySelectorAll("[class*='KsButton']")) {
        if ((el.textContent || "").trim() !== "Confirm") continue;
        const btn = el.shadowRoot ? el.shadowRoot.querySelector("button") : null;
        if (btn) { btn.click(); return "ksbutton-shadow"; }
        el.click(); return "ksbutton-host";
      }
      for (const btn of root.querySelectorAll("button")) {
        if ((btn.textContent || "").trim() === "Confirm") { btn.click(); return "plain-button"; }
      }
      return null;
    }
  `;

  // Try 1: find footer then confirm inside it
  let clicked = await page.evaluate((FINDER) => {
    eval(FINDER); // eslint-disable-line no-eval
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
    return findAndClickConfirm(footer);
  }, CONFIRM_FINDER);
  lg(onLog, "info", `   🗓️  Confirm try 1: ${clicked}`);
  if (clicked && clicked !== "no-footer") { await sleep(500); return; }

  // Try 2: find popup then walk shadow roots inside it
  clicked = await page.evaluate((FINDER) => {
    eval(FINDER); // eslint-disable-line no-eval
    function findPopup(root) {
      const el = root.querySelector(".picker-core__popup");
      if (el) return el;
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const r = findPopup(c.shadowRoot); if (r) return r; }
      }
      return null;
    }
    function walkConfirm(root) {
      const r = findAndClickConfirm(root);
      if (r) return r;
      for (const c of root.querySelectorAll("*")) {
        if (c.shadowRoot) { const s = walkConfirm(c.shadowRoot); if (s) return s; }
      }
      return null;
    }
    const popup = findPopup(document);
    if (!popup) return "no-popup";
    return walkConfirm(popup);
  }, CONFIRM_FINDER);
  lg(onLog, "info", `   🗓️  Confirm try 2: ${clicked}`);
  if (clicked && clicked !== "no-popup") { await sleep(500); return; }

  // Try 3: global walk — find any Confirm button that's inside a picker popup ancestor
  clicked = await page.evaluate((FINDER) => {
    eval(FINDER); // eslint-disable-line no-eval
    function insidePicker(el) {
      let node = el;
      while (node) {
        if (node.classList && (
          node.classList.contains("picker-core__popup") ||
          node.classList.contains("picker-core__popup-footer") ||
          node.classList.contains("picker-core__popup-footer-append")
        )) return true;
        node = node.parentElement || (node.getRootNode?.()?.host);
      }
      return false;
    }
    function walk(root) {
      for (const el of root.querySelectorAll("[class*='KsButton']")) {
        if ((el.textContent || "").trim() !== "Confirm") continue;
        if (!insidePicker(el)) continue;
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
  }, CONFIRM_FINDER);
  lg(onLog, "info", `   🗓️  Confirm try 3: ${clicked}`);
  if (clicked) { await sleep(500); return; }

  lg(onLog, "warn", "   🗓️  ⚠️  All Confirm tries failed — date may not be applied");
  await sleep(500);
}

// ════════════════════════════════════════════════════════
// SET DATE RANGE (open picker → navigate → click from → click to → confirm)
// ════════════════════════════════════════════════════════

async function setDateRange(page, dateFrom, dateTo, onLog) {
  const fY = dateFrom.getFullYear(), fM = dateFrom.getMonth(), fD = dateFrom.getDate();
  const tY = dateTo.getFullYear(),   tM = dateTo.getMonth(),   tD = dateTo.getDate();
  const isSame = fY === tY && fM === tM && fD === tD;

  lg(onLog, "info",
    `📅 Setting date: ${MONTH_NAMES[fM]} ${fD} ${fY}` +
    (isSame ? " (single day)" : ` → ${MONTH_NAMES[tM]} ${tD} ${tY}`)
  );

  const opened = await openDatePicker(page, onLog);
  if (!opened) lg(onLog, "warn", "⚠️ Calendar may not have opened — continuing anyway");

  await navigateToMonth(page, fY, fM, onLog);
  await clickDay(page, fD, fM, fY, onLog);

  if (isSame) {
    // Click same day again for the TO date
    await clickDay(page, fD, fM, fY, onLog);
  } else {
    await navigateToMonth(page, tY, tM, onLog);
    await clickDay(page, tD, tM, tY, onLog);
  }

  await clickConfirm(page, onLog);
  lg(onLog, "ok", "✅ Date range set and confirmed");
  await sleep(500);
}

// ════════════════════════════════════════════════════════
// WAIT FOR TABLE — polls until currency value appears
//
// Rules:
//   "—"       → still loading → keep waiting
//   "0.00 SAR" → real zero, done → accept
//   "1,234 SAR" → has spend → accept
//
// Timeout bumped to 45s (was 35s) — slow accounts need more time.
// ════════════════════════════════════════════════════════

async function waitForTable(page, ms, onLog) {
  lg(onLog, "info", "   💰 Waiting for real value (SAR/currency) in spend slot...");
  const CURRENCY_RE_STR = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
  const start = Date.now();

  while (Date.now() - start < ms) {
    if (isLoginUrl(page.url())) {
      lg(onLog, "warn", "   ⚠️ Redirected to login while waiting for table");
      return { status: "login" };
    }

    const found = await page.evaluate(() => {
      const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
      function getSpendText(root) {
        const slot = root.querySelector('[slot="footer-stat_cost"]');
        if (slot) {
          const t = slot.textContent?.trim();
          if (t) return t;
        }
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
      if (CURRENCY_RE.test(text)) return { ready: true, text };
      return { ready: false, text, reason: "no-currency-yet" };
    });

    if (found.ready) {
      lg(onLog, "ok", `   💰 Table loaded ✅  value: "${found.text}"`);
      return { status: "ready", text: found.text };
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    const display = found.text === null ? `"-" (${found.reason})` : `"${found.text}"`;
    lg(onLog, "info", `   💰 Still loading... slot=${display} (${elapsed}s elapsed)`);
    await sleep(800);
  }

  lg(onLog, "warn", `   💰 ${ms / 1000}s timeout — no currency value appeared`);
  return { status: "timeout" };
}

// ════════════════════════════════════════════════════════
// READ SPEND — with 45s wait + full-page fallback scan
// ════════════════════════════════════════════════════════

async function readSpend(page, onLog) {
  const tableResult = await waitForTable(page, 45000, onLog); // bumped from 35s

  if (tableResult.status === "login") return "SESSION_EXPIRED";

  if (tableResult.status === "timeout") {
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
    lg(onLog, "warn", "   💰 Nothing found anywhere — returning 0");
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
      lg(onLog, "warn", "   ⚠️ TikTok redirected to login during page wait");
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
            if (el.tagName?.toLowerCase().includes("display-field") && el.shadowRoot) {
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

    await sleep(2000);
  }

  lg(onLog, "warn", "   ⚠️ Campaigns page wait timed out — trying anyway");
  return true;
}

// ════════════════════════════════════════════════════════
// SCRAPE ONE ACCOUNT (reuses an already-open page)
// ════════════════════════════════════════════════════════

async function scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog) {
  lg(onLog, "info", `   🌐 Account entry: ${accountUrl.slice(0, 80)}`);

  // Normalise: if it's a bare numeric ID, build the full URL
  let cleanUrl = accountUrl;
  let aadvid   = null;
  try {
    const trimmed = accountUrl.trim();
    if (/^\d+$/.test(trimmed)) {
      aadvid   = trimmed;
      cleanUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`;
    } else {
      const u  = new URL(trimmed);
      aadvid   = u.searchParams.get("aadvid");
      cleanUrl = aadvid
        ? `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`
        : trimmed;
    }
    lg(onLog, "info", `   🌐 aadvid: ${aadvid} → ${cleanUrl}`);
  } catch (e) {
    lg(onLog, "warn", `   🌐 URL parse error: ${e.message}`);
  }

  // Navigate with one retry if we land on login
  for (let attempt = 0; attempt < 2; attempt++) {
    lg(onLog, "info", `   🌐 Navigating... (attempt ${attempt + 1})`);
    await gotoWithRetry(page, cleanUrl, onLog, `Campaign page ${aadvid || "?"}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
      attempts: process.platform === "darwin" ? 4 : 3,
    });
    await sleep(800);
    if (isLoginUrl(page.url())) {
      lg(onLog, "warn", "   ⚠️ Redirected to login — recovering...");
      await ensureSession(page, onLog, `account ${aadvid || "?"}`);
      continue;
    }
    break;
  }

  await waitForCampaignsPage(page, aadvid, onLog);

  // One more session check before we start interacting
  if (isLoginUrl(page.url())) {
    await ensureSession(page, onLog, `pre-scrape ${aadvid || "?"}`);
    await gotoWithRetry(page, cleanUrl, onLog, `Pre-scrape campaign reload ${aadvid || "?"}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await sleep(800);
    await waitForCampaignsPage(page, aadvid, onLog);
  }

  await setDateRange(page, dateFrom, dateTo, onLog);

  // Guard: detect accidental navigation to campaign creation form
  const postDateUrl = page.url();
  if (postDateUrl.includes("/creation/") || postDateUrl.includes("/create/campaign")) {
    lg(onLog, "warn", `   ⚠️ Accidental navigation to campaign creation — recovering...`);
    await page.keyboard.press("Escape");
    await sleep(300);
    await gotoWithRetry(page, cleanUrl, onLog, `Campaign creation recovery ${aadvid || "?"}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await sleep(800);
    await waitForCampaignsPage(page, aadvid, onLog);
    await setDateRange(page, dateFrom, dateTo, onLog);
  }

  let spend = await readSpend(page, onLog);

  // Session expired mid-scrape — recover and try once more
  if (spend === "SESSION_EXPIRED") {
    lg(onLog, "warn", "   ⚠️ Session expired while reading spend — recovering...");
    await ensureSession(page, onLog, `spend-read ${aadvid || "?"}`);
    await gotoWithRetry(page, cleanUrl, onLog, `Spend-read campaign reload ${aadvid || "?"}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await sleep(800);
    await waitForCampaignsPage(page, aadvid, onLog);
    await setDateRange(page, dateFrom, dateTo, onLog);
    spend = await readSpend(page, onLog);
    if (spend === "SESSION_EXPIRED") {
      lg(onLog, "warn", "   ⚠️ Spend still unreadable after session recovery — using 0");
      spend = 0;
    }
  }

  lg(onLog, "ok", `   ✅ Spend: ${spend}`);
  return spend;
}

// ════════════════════════════════════════════════════════
// SCRAPE ONE ACCOUNT WITH ITS OWN CHROME
//
// launch Chrome → verify session → scrape → ALWAYS close Chrome.
// The `finally` block guarantees Chrome closes even if scraping throws.
// ════════════════════════════════════════════════════════

async function scrapeAccountWithOwnChrome(accountUrl, dateFrom, dateTo, onLog, launchMinimized) {
  const label = accountUrl.trim().slice(0, 50);
  lg(onLog, "info", `\n🚀 Launching Chrome for: ${label}`);

  const { context, page } = await launchChrome(onLog, "tiktok-shared", launchMinimized);
  try {
    await confirmInitialLogin(page, onLog);
    return await scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog);
  } finally {
    // Always runs — Chrome is ALWAYS closed, even on throw
    lg(onLog, "info", `🔒 Closing Chrome for: ${label}`);
    await closeChrome(context, onLog);
  }
}

// ════════════════════════════════════════════════════════
// SINGLE-ACCOUNT ENTRY POINT
// Used by runner.js global sequential queue.
// Never throws — returns 0 on any failure.
// ════════════════════════════════════════════════════════

async function scrapeOneAccount({ accountId, dateFrom, dateTo, onLog, launchMinimized }) {
  const fromDate = new Date(dateFrom);
  const toDate   = new Date(dateTo || dateFrom);
  try {
    const spend = await scrapeAccountWithOwnChrome(accountId, fromDate, toDate, onLog, launchMinimized);
    return typeof spend === "number" ? spend : 0;
  } catch (err) {
    lg(onLog, "warn", `⚠️ scrapeOneAccount [${accountId}] failed: ${err.message} — using 0`);
    return 0;
  }
}

// ════════════════════════════════════════════════════════
// LEGACY per-member entry point (kept for backward compat)
// runner.js now uses scrapeOneAccount instead.
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
      if (cancelToken?.cancelled) {
        lg(onLog, "warn", "⏹ Stop requested — TikTok stopping.");
        break;
      }
      lg(onLog, "info", `\n🎵 ── Account ${i + 1} of ${accounts.length} ──`);
      try {
        const spend = await scrapeAccountWithOwnChrome(accounts[i], fromDate, toDate, onLog, launchMinimized);
        const n = typeof spend === "number" ? spend : 0;
        totalSpend += n;
        lg(onLog, "ok", `🎵 Account ${i + 1}: ${n} | Running total: ${totalSpend}`);
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

module.exports = { runTikTok, scrapeOneAccount };
