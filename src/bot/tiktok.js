"use strict";

/**
 * tiktok.js — TikTok Ads spend scraper
 *
 * ALL elements are inside nested Shadow DOM — must use page.evaluate() to reach them.
 * Component names use suffix "-1-1-14" (NOT "-91z" which was an old version).
 *
 * Flow per account:
 *   1. Navigate to clean campaign URL
 *   2. Click the date picker trigger (ks-date-time-picker-display-field-1-1-14 shadow button)
 *   3. Set date range — click FROM day, click TO day (same day twice for single date)
 *   4. Click Confirm (ks-button-1-1-14[data-testid="core-index-g1HneZ"] shadow button)
 *   5. Wait for table, read spend from div[slot="footer-stat_cost"] ks-text-1-1-14
 */

const { launchChrome, closeChrome } = require("./browser");

const TT_LOGIN_URL = "https://ads.tiktok.com/i18n/login";
const MONTH_NAMES  = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];

function lg(onLog, type, msg) { onLog({ type, msg }); }

function parseSpend(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, "").match(/[\d]+\.?\d*/);
  const v = m ? parseFloat(m[0]) : 0;
  return isNaN(v) ? 0 : v;
}

// ════════════════════════════════════════════════════════
// SHADOW DOM HELPERS — everything is buried in shadow roots
// ════════════════════════════════════════════════════════

// Walk all shadow roots recursively and call finder(root) — return first truthy result
async function evalShadow(page, finderFn) {
  return page.evaluate((fnStr) => {
    const fn = new Function("root", fnStr);
    function walk(root) {
      const r = fn(root);
      if (r) return r;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const r2 = walk(el.shadowRoot);
          if (r2) return r2;
        }
      }
      return null;
    }
    return walk(document);
  }, finderFn);
}

// ── OPEN DATE PICKER ──
// The trigger is the <button> inside ks-date-time-picker-display-field-1-1-14's shadow root
async function openDatePicker(page, onLog) {
  lg(onLog, "info", "   🗓️  Opening date picker...");

  // Try 1: evaluate into shadow DOM to find and click the display field button
  lg(onLog, "info", "   🗓️  Try 1: shadow DOM display-field button...");
  let clicked = await page.evaluate(() => {
    function walk(root) {
      // Look for ks-date-time-picker-display-field with any suffix
      const fields = root.querySelectorAll("[class*='KsDateRangePicker'] ks-date-time-picker-display-field-1-1-14, ks-date-time-picker-display-field-1-1-14");
      for (const f of fields) {
        if (f.shadowRoot) {
          const btn = f.shadowRoot.querySelector("button");
          if (btn) { btn.click(); return true; }
        }
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return false;
    }
    return walk(document);
  });
  lg(onLog, "info", `   🗓️  Try 1 result: ${clicked}`);

  if (!clicked) {
    // Try 2: find any element whose tag contains "display-field" and click its shadow button
    lg(onLog, "info", "   🗓️  Try 2: generic display-field tag search...");
    clicked = await page.evaluate(() => {
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
    lg(onLog, "info", `   🗓️  Try 2 result: ${clicked}`);
  }

  if (!clicked) {
    // Try 3: find element containing date text like "Apr" and click it
    lg(onLog, "info", "   🗓️  Try 3: click element with date text...");
    clicked = await page.evaluate(() => {
      function walk(root) {
        for (const el of root.querySelectorAll("button, div[class*='display-field']")) {
          const t = el.textContent || "";
          if (/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(t) && t.length < 40) {
            el.click(); return true;
          }
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return false;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Try 3 result: ${clicked}`);
  }

  if (!clicked) {
    // Try 4: find the picker wrapper div and click it
    lg(onLog, "info", "   🗓️  Try 4: click picker--MUHRw wrapper...");
    clicked = await page.evaluate(() => {
      const el = document.querySelector("[class*='picker--']");
      if (el) { el.click(); return true; }
      return false;
    });
    lg(onLog, "info", `   🗓️  Try 4 result: ${clicked}`);
  }

  await page.waitForTimeout(1000);

  // Verify calendar opened — look for date-grid-body__date-item in any shadow root
  lg(onLog, "info", "   🗓️  Verifying calendar opened...");
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

  await page.waitForTimeout(300);
  return calOpen;
}

// ── GET CURRENT MONTH/YEAR from visible calendar ──
async function getCurrentMonthYear(page) {
  return page.evaluate(() => {
    const MONTHS = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
    function walk(root) {
      // Look for date-grid-header__labels-part--clickable buttons
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

// ── NAVIGATE TO TARGET MONTH ──
async function navigateToMonth(page, targetYear, targetMonth, onLog) {
  for (let i = 0; i < 24; i++) {
    const cur = await getCurrentMonthYear(page);
    if (!cur) { lg(onLog, "warn", "   🗓️  Could not read current month"); break; }
    lg(onLog, "info", `   🗓️  Calendar shows: ${cur.monthName} ${cur.year} → want: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
    if (cur.year === targetYear && cur.monthIdx === targetMonth) break;

    const curTotal    = cur.year * 12 + cur.monthIdx;
    const targetTotal = targetYear * 12 + targetMonth;
    const goBack      = targetTotal < curTotal;

    // Click prev or next chevron — inside shadow DOM
    const moved = await page.evaluate((goBack) => {
      function walk(root) {
        // Find chevron-left or chevron-right icon buttons
        const icons = root.querySelectorAll(goBack ? "ks-icon-chevron-left" : "ks-icon-chevron-right");
        for (const icon of icons) {
          const btn = icon.closest("button") || icon.parentElement?.closest("button");
          if (btn && !btn.closest("[class*='hidden']")) { btn.click(); return true; }
        }
        // Try data-testid on icon buttons
        const ibtns = root.querySelectorAll("ks-icon-button-1-1-14");
        for (const ib of ibtns) {
          if (ib.shadowRoot) {
            const b = ib.shadowRoot.querySelector("button");
            if (b) {
              const icon = ib.querySelector(goBack ? "ks-icon-chevron-left" : "ks-icon-chevron-right");
              if (icon) { b.click(); return true; }
            }
          }
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return false;
      }
      return walk(document);
    }, goBack);

    lg(onLog, "info", `   🗓️  Navigate ${goBack ? "←" : "→"}: ${moved}`);
    await page.waitForTimeout(400);
  }
}

// ── CLICK A SPECIFIC DAY ──
async function clickDay(page, day, targetMonth, targetYear, onLog) {
  const dayStr = String(day);
  lg(onLog, "info", `   🗓️  Clicking day ${dayStr} (${MONTH_NAMES[targetMonth]} ${targetYear})...`);

  // Try 1: data-testid ending in -day (no suffix "outside-current-period")
  let clicked = await page.evaluate((dayStr) => {
    function walk(root) {
      // Find all date items, pick the one matching day that is NOT outside current period
      const items = root.querySelectorAll(".date-grid-body__date-item");
      for (const item of items) {
        const t = item.textContent.trim();
        const cls = item.className || "";
        if (t === dayStr && !cls.includes("outside-current-period")) {
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
  lg(onLog, "info", `   🗓️  Day click try 1 (class match): ${clicked}`);

  if (!clicked) {
    // Try 2: data-testid ending in -{day}
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

  await page.waitForTimeout(400);
  return clicked;
}

// ── CLICK CONFIRM ──
async function clickConfirm(page, onLog) {
  lg(onLog, "info", "   🗓️  Clicking Confirm...");

  // Try 1: data-testid="core-index-g1HneZ" shadow button
  let clicked = await page.evaluate(() => {
    function walk(root) {
      const host = root.querySelector('ks-button-1-1-14[data-testid="core-index-g1HneZ"]');
      if (host?.shadowRoot) {
        const btn = host.shadowRoot.querySelector("button");
        if (btn) { btn.click(); return "testid-shadow"; }
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return null;
    }
    return walk(document);
  });
  lg(onLog, "info", `   🗓️  Confirm try 1 (testid shadow): ${clicked}`);

  if (!clicked) {
    // Try 2: any ks-button with text "Confirm"
    clicked = await page.evaluate(() => {
      function walk(root) {
        const btns = root.querySelectorAll("ks-button-1-1-14, ks-button-91z");
        for (const btn of btns) {
          if ((btn.textContent || "").trim() === "Confirm") {
            const shadow = btn.shadowRoot?.querySelector("button");
            if (shadow) { shadow.click(); return "text-shadow"; }
            btn.click(); return "text-host";
          }
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Confirm try 2 (text match): ${clicked}`);
  }

  if (!clicked) {
    // Try 3: find button with type-contained + color-primary class (the blue confirm button)
    clicked = await page.evaluate(() => {
      function walk(root) {
        const btns = root.querySelectorAll("button.button--type-contained.button--color-primary");
        if (btns.length > 0) { btns[btns.length - 1].click(); return "class-match"; }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Confirm try 3 (class match): ${clicked}`);
  }

  if (!clicked) {
    // Try 4: footer-append area, click last button
    clicked = await page.evaluate(() => {
      function walk(root) {
        const footer = root.querySelector(".picker-core__popup-footer-append");
        if (footer) {
          const btns = footer.querySelectorAll("button, ks-button-1-1-14");
          if (btns.length > 0) { btns[btns.length - 1].click(); return "footer-last"; }
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      return walk(document);
    });
    lg(onLog, "info", `   🗓️  Confirm try 4 (footer last): ${clicked}`);
  }

  await page.waitForTimeout(1500);
}

// ════════════════════════════════════════════════════════
// SET DATE RANGE — main orchestrator
// ════════════════════════════════════════════════════════
async function setDateRange(page, dateFrom, dateTo, onLog) {
  const fY = dateFrom.getFullYear(), fM = dateFrom.getMonth(), fD = dateFrom.getDate();
  const tY = dateTo.getFullYear(),   tM = dateTo.getMonth(),   tD = dateTo.getDate();
  const isSame = fY===tY && fM===tM && fD===tD;

  lg(onLog, "info", `📅 Setting date: ${MONTH_NAMES[fM]} ${fD} ${fY}${isSame ? " (single)" : " → " + MONTH_NAMES[tM] + " " + tD + " " + tY}`);

  // Open picker
  const opened = await openDatePicker(page, onLog);
  if (!opened) {
    lg(onLog, "warn", "⚠️ Calendar may not have opened — trying to continue anyway");
  }
  await page.waitForTimeout(500);

  // Navigate to FROM month
  await navigateToMonth(page, fY, fM, onLog);
  await page.waitForTimeout(300);

  // Click FROM day
  await clickDay(page, fD, fM, fY, onLog);
  await page.waitForTimeout(500);

  // Click TO day (same day again if single date)
  if (isSame) {
    lg(onLog, "info", `   🗓️  Single date — clicking day ${fD} again for TO...`);
    await clickDay(page, fD, fM, fY, onLog);
  } else {
    // Navigate to TO month if different
    await navigateToMonth(page, tY, tM, onLog);
    await page.waitForTimeout(300);
    await clickDay(page, tD, tM, tY, onLog);
  }
  await page.waitForTimeout(400);

  // Confirm
  await clickConfirm(page, onLog);
  lg(onLog, "ok", "✅ Date range set and confirmed");
  await page.waitForTimeout(2000);
}

// ════════════════════════════════════════════════════════
// READ SPEND — from footer slot
// div[slot="footer-stat_cost"] → ks-text-1-1-14 → shadow <slot> → text content
// ════════════════════════════════════════════════════════
async function waitForTable(page, ms, onLog) {
  lg(onLog, "info", "   💰 Waiting for table to load...");
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = await page.evaluate(() => {
      // Check for tfoot or footer-stat_cost slot
      if (document.querySelector("tfoot")) return "tfoot";
      function walk(root) {
        if (root.querySelector("[slot='footer-stat_cost']")) return "slot";
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      return walk(document);
    });
    if (found) { lg(onLog, "info", `   💰 Table found (${found})`); return true; }
    await page.waitForTimeout(600);
  }
  lg(onLog, "warn", `   💰 Table not found after ${ms/1000}s`);
  return false;
}

async function readSpend(page, onLog) {
  await waitForTable(page, 25000, onLog);
  await page.waitForTimeout(1000);

  lg(onLog, "info", "   💰 Reading spend...");

  // Try 1: div[slot="footer-stat_cost"] ks-text content via shadow walk
  let result = await page.evaluate(() => {
    // The slot div is in the light DOM but ks-text's text is in its shadow <slot>
    const slotDiv = document.querySelector('div[slot="footer-stat_cost"]');
    if (!slotDiv) return { found: false, method: "no-slot-div" };
    // ks-text-1-1-14 — its text is directly as textContent (shadow slot passes through)
    const ksText = slotDiv.querySelector("ks-text-1-1-14");
    if (ksText) {
      const t = ksText.textContent?.trim();
      if (t) return { found: true, text: t, method: "ks-text-1-1-14" };
    }
    // fallback: any text in the slot div
    const t = slotDiv.textContent?.trim();
    return t ? { found: true, text: t, method: "slot-div-text" } : { found: false, method: "empty-slot" };
  });
  lg(onLog, "info", `   💰 Try 1 (slot div): found=${result.found} method=${result.method} text="${result.text || ""}"`);
  if (result.found && result.text && result.text !== "—") return parseSpend(result.text);

  // Try 2: walk all shadow roots for footer-stat_cost slot
  result = await page.evaluate(() => {
    function walk(root) {
      const slot = root.querySelector('[slot="footer-stat_cost"]');
      if (slot) {
        const t = slot.textContent?.trim();
        if (t && t !== "—") return { found: true, text: t, method: "shadow-walk-slot" };
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return { found: false };
    }
    return walk(document);
  });
  lg(onLog, "info", `   💰 Try 2 (shadow walk slot): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  // Try 3: find tfoot and look for cost column
  result = await page.evaluate(() => {
    const tfoot = document.querySelector("tfoot");
    if (!tfoot) return { found: false, method: "no-tfoot" };
    // Look for th with data-testid containing stat_cost
    const th = tfoot.querySelector('[data-testid*="stat_cost"], [slot*="stat_cost"]');
    if (th) return { found: true, text: th.textContent?.trim(), method: "tfoot-testid" };
    // Just grab all th text
    const ths = [...tfoot.querySelectorAll("th")];
    const texts = ths.map(t => t.textContent?.trim()).filter(Boolean);
    return { found: texts.length > 0, text: texts.join(" | "), method: "tfoot-all-ths" };
  });
  lg(onLog, "info", `   💰 Try 3 (tfoot): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) {
    // Extract first SAR/USD amount
    const m = result.text.match(/[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/);
    if (m) return parseSpend(m[0]);
  }

  // Try 4: grab ALL text from any element matching ks-text that contains SAR/number
  result = await page.evaluate(() => {
    function walk(root) {
      // Find ks-text elements in footer area
      const texts = root.querySelectorAll("ks-text-1-1-14, ks-text-91z");
      for (const el of texts) {
        const t = el.textContent?.trim() || "";
        if (/[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/.test(t)) {
          return { found: true, text: t, method: "ks-text-currency" };
        }
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return { found: false };
    }
    return walk(document);
  });
  lg(onLog, "info", `   💰 Try 4 (ks-text currency): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  lg(onLog, "warn", "   💰 All spend methods failed — using 0");
  return 0;
}

// ════════════════════════════════════════════════════════
// WAIT FOR CAMPAIGNS PAGE
// ════════════════════════════════════════════════════════
async function waitForCampaignsPage(page, aadvid, onLog) {
  lg(onLog, "info", `   🌐 Waiting for campaigns page (aadvid: ${aadvid})...`);
  const deadline = Date.now() + 3 * 60 * 1000; // 3 min max wait
  let lastLog = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    const isLogin = url.includes("/login") || url.includes("/auth") ||
                    url.includes("redirect=") || !url.includes("ads.tiktok.com");

    if (Date.now() - lastLog > 5000) {
      lg(onLog, "info", `   🌐 URL: ${url.slice(0, 90)}`);
      lg(onLog, "info", `   🌐 isLogin: ${isLogin} | hasAadvid: ${aadvid ? url.includes(aadvid) : "n/a"}`);
      lastLog = Date.now();
    }

    if (!isLogin && (!aadvid || url.includes(aadvid))) {
      // Check if date picker trigger is accessible in shadow DOM
      const pickerFound = await page.evaluate(() => {
        function walk(root) {
          // Look for display-field element
          for (const el of root.querySelectorAll("*")) {
            if (el.tagName && el.tagName.toLowerCase().includes("display-field") && el.shadowRoot) {
              const btn = el.shadowRoot.querySelector("button");
              if (btn) return true;
            }
            if (el.shadowRoot && walk(el.shadowRoot)) return true;
          }
          return false;
        }
        return walk(document);
      });

      if (pickerFound) {
        lg(onLog, "ok", "   ✅ Campaigns page ready — date picker found in shadow DOM");
        return true;
      }
      lg(onLog, "info", "   🌐 On campaigns page but picker not ready yet...");
    }

    await page.waitForTimeout(2000);
  }
  lg(onLog, "warn", "   ⚠️ Campaigns page wait timed out — trying anyway");
  return false;
}

// ════════════════════════════════════════════════════════
// SCRAPE ONE ACCOUNT
// ════════════════════════════════════════════════════════
async function scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog) {
  lg(onLog, "info", `   🌐 Account URL: ${accountUrl.slice(0, 80)}`);

  // Clean URL — only keep aadvid param
  let cleanUrl = accountUrl;
  let aadvid = null;
  try {
    const u = new URL(accountUrl);
    aadvid = u.searchParams.get("aadvid");
    if (aadvid) cleanUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`;
    lg(onLog, "info", `   🌐 Clean URL: ${cleanUrl}`);
  } catch (e) {
    lg(onLog, "warn", `   🌐 URL parse error: ${e.message}`);
  }

  lg(onLog, "info", "   🌐 Navigating...");
  await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  lg(onLog, "info", `   🌐 After nav: ${page.url().slice(0, 80)}`);

  await waitForCampaignsPage(page, aadvid, onLog);

  lg(onLog, "info", "   📅 Setting date range...");
  await setDateRange(page, dateFrom, dateTo, onLog);

  lg(onLog, "info", "   💰 Reading spend...");
  const spend = await readSpend(page, onLog);
  lg(onLog, "ok", `   ✅ Spend: ${spend}`);
  return spend;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized }) {
  const fromDate = new Date(dateFrom);
  const toDate   = new Date(dateTo || dateFrom);

  const accounts = (member.tiktokAccounts || []).filter(a => a && a.trim() !== "");
  if (accounts.length === 0) {
    lg(onLog, "warn", `⚠️ No TikTok accounts for ${member.name}`);
    return { success: true, memberId: member.id, totalSpend: 0 };
  }

  lg(onLog, "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lg(onLog, "info", `🎵 TikTok: ${member.name} — ${accounts.length} account(s)`);
  lg(onLog, "info", `   Date: ${fromDate.toDateString()} → ${toDate.toDateString()}`);

  // All TikTok accounts live under the same TikTok Ads Manager login.
  // One shared profile — "tiktok-shared" — holds the session for ALL members.
  // No per-member profile needed.
  const { context, page } = await launchChrome(onLog, `tiktok-shared`, launchMinimized);

  try {
    // Open login page — wait for session or manual login
    lg(onLog, "info", `🔑 Opening TikTok login...`);
    await page.goto(TT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    lg(onLog, "info", `🔑 URL: ${page.url().slice(0, 80)}`);

    const alreadyIn = page.url().includes("ads.tiktok.com") &&
                      !page.url().includes("/login") &&
                      !page.url().includes("/auth");

    if (alreadyIn) {
      lg(onLog, "ok", "✅ Already logged in (saved session)");
    } else {
      lg(onLog, "warn", `⏳ Please log in to TikTok Ads for ${member.name} (up to 10 min)...`);
      const deadline = Date.now() + 10 * 60 * 1000;
      let confirmed = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        const u = page.url();
        if (u.includes("ads.tiktok.com") && !u.includes("/login") && !u.includes("/auth") && !u.includes("redirect=")) {
          confirmed = true;
          lg(onLog, "ok", `✅ Login confirmed — ${u.slice(0, 60)}`);
          break;
        }
      }
      if (!confirmed) throw new Error(`TikTok login timeout for ${member.name}`);
    }

    // Scrape each account in same Chrome window
    let totalSpend = 0;
    for (let i = 0; i < accounts.length; i++) {
      lg(onLog, "info", `\n🎵 ── Account ${i + 1}/${accounts.length} ──`);
      try {
        const spend = await scrapeAccount(page, accounts[i], fromDate, toDate, onLog);
        totalSpend += spend;
        lg(onLog, "ok", `🎵 Account ${i + 1}: ${spend} | Total so far: ${totalSpend}`);
      } catch (err) {
        lg(onLog, "warn", `⚠️ Account ${i + 1} error: ${err.message} — using 0`);
      }
    }

    lg(onLog, "ok", `✅ TikTok total for ${member.name}: ${totalSpend}`);
    await closeChrome(context, onLog);
    return { success: true, memberId: member.id, totalSpend };

  } catch (err) {
    lg(onLog, "error", `❌ TikTok fatal [${member.name}]: ${err.message}`);
    await closeChrome(context, onLog).catch(() => {});
    return { success: false, memberId: member.id, totalSpend: 0, error: err.message };
  }
}

module.exports = { runTikTok };
