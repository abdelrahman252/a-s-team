"use strict";

/**
 * tiktok.js — TikTok Ads spend scraper
 *
 * SHADOW DOM STRATEGY — NO SUFFIX SELECTORS EVER:
 * ─────────────────────────────────────────────────
 *  TikTok's component suffix (e.g. -1-1-14, -1-1-19) changes between accounts
 *  and deployments. ALL selectors use suffix-free approaches only:
 *    • data-testid attributes
 *    • CSS class names (.date-grid-body__date-item, .picker-core__popup-footer-append etc.)
 *    • tag name PATTERNS (el.tagName.toLowerCase().includes("display-field"))
 *    • icon tag names (ks-icon-chevron-right — icons have NO suffix, they are stable)
 *    • [class*='KsButton'] partial class match
 *    • text content ("Confirm")
 *
 * CALENDAR LAYOUT:
 *  Dual-panel picker — LEFT shows earlier month, RIGHT shows later month.
 *  LEFT panel:  .date-grid-header__controls (visible ←), --hidden class on right controls
 *  RIGHT panel: .date-grid-header__controls (visible →), --hidden class on left controls
 *  Always click the arrow inside a NON-hidden controls group.
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
// SHARED CHROME STATE + MUTEX
// ════════════════════════════════════════════════════════

let _sharedContext = null;
let _sharedPage    = null;
let _tiktokMutexTail = Promise.resolve();

async function withTiktokLock(fn) {
  let release;
  const acquired = new Promise(res => { release = res; });
  const previous = _tiktokMutexTail;
  _tiktokMutexTail = previous.then(() => acquired);
  await previous;
  try { return await fn(); } finally { release(); }
}

async function initSharedChrome(onLog, launchMinimized) {
  if (_sharedContext && _sharedPage) return;
  _tiktokMutexTail = Promise.resolve();
  const { context, page } = await launchChrome(onLog, "tiktok-shared", launchMinimized);
  _sharedContext = context;
  _sharedPage    = page;
}

async function closeSharedChrome(onLog) {
  if (_sharedContext) {
    await closeChrome(_sharedContext, onLog);
    _sharedContext = null;
    _sharedPage    = null;
  }
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
  // Navigate to the ads dashboard — if session is alive it stays there,
  // if expired TikTok redirects us to the login page.
  await page.goto("https://ads.tiktok.com/i18n/dashboard", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  if (!isLoginUrl(page.url())) {
    lg(onLog, "ok", "✅ Already logged in — skipping login");
    return;
  }
  await ensureSession(page, onLog, "initial login");
}

// ════════════════════════════════════════════════════════
// OPEN DATE PICKER — suffix-free
// ════════════════════════════════════════════════════════

async function openDatePicker(page, onLog) {
  lg(onLog, "info", "   🗓️  Opening date picker...");

  // Try 1: any element whose tag name contains "display-field" → click its shadow button
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

  // Try 2: data-testid containing "display-field"
  if (!clicked) {
    clicked = await page.evaluate(() => {
      function walk(root) {
        for (const el of root.querySelectorAll("[data-testid*='display-field']")) {
          if (el.shadowRoot) {
            const btn = el.shadowRoot.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
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

  // Try 3: shadow button whose text contains a month name (date display)
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

  // Try 4: element with class containing "picker" 
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
// GET CURRENT MONTH/YEAR — reads LEFT panel label buttons
// Uses only stable class names
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
// Uses: tag name pattern for header elements, stable class names for control groups,
//       ks-icon-chevron-left/right (icon tags have NO suffix — stable),
//       [class*='KsIconButton'] for the button wrapper
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

      // Find the shadow root of a header element, then find a VISIBLE control group
      // containing the target icon, then click its button wrapper.
      function tryInHeaderShadow(shadow) {
        const groups = shadow.querySelectorAll(".date-grid-header__controls");
        for (const group of groups) {
          // Skip hidden groups — this is the key fix for dual-panel layout
          if (group.classList.contains("date-grid-header__controls--hidden")) continue;
          const icon = group.querySelector(iconTag);
          if (!icon) continue;
          // The icon is inside a wrapper whose tag we don't know (suffix varies).
          // Find by class attribute partial match — [class*='KsIconButton'] is stable.
          const wrapper = icon.closest("[class*='KsIconButton']");
          if (wrapper && wrapper.shadowRoot) {
            const btn = wrapper.shadowRoot.querySelector("button");
            if (btn) { btn.click(); return true; }
          }
          // Fallback: walk up to find any ancestor with a shadowRoot containing a button
          let node = icon.parentElement;
          while (node) {
            if (node.shadowRoot) {
              const btn = node.shadowRoot.querySelector("button");
              if (btn) { btn.click(); return true; }
            }
            node = node.parentElement;
          }
          // Last resort: click the icon element itself
          icon.click(); return true;
        }
        return false;
      }

      // Single-pass recursive walk: for every element, if it's a date-grid-header
      // try clicking its shadow arrow; ALSO recurse into its shadow root either way
      // so nothing buried deeper gets missed.
      function walk(root) {
        for (const el of root.querySelectorAll("*")) {
          if (el.tagName && el.tagName.toLowerCase().includes("date-grid-header") && el.shadowRoot) {
            if (tryInHeaderShadow(el.shadowRoot)) return true;
            // Still recurse in case headers are nested (shouldn't happen but safe)
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
// Uses: .date-grid-body__date-item class, data-testid suffix match, text content
// ════════════════════════════════════════════════════════

async function clickDay(page, day, targetMonth, targetYear, onLog) {
  const dayStr = String(day);
  lg(onLog, "info", `   🗓️  Clicking day ${dayStr} (${MONTH_NAMES[targetMonth]} ${targetYear})...`);

  // Try 1: class-based, text match, not outside current period
  let clicked = await page.evaluate((dayStr) => {
    function walk(root) {
      const items = root.querySelectorAll(".date-grid-body__date-item");
      for (const item of items) {
        const t   = item.textContent.trim();
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
  lg(onLog, "info", `   🗓️  Day click try 1 (class+text): ${clicked}`);

  // Try 2: data-testid ending with the day number
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

  await page.waitForTimeout(150);
  return clicked;
}

// ════════════════════════════════════════════════════════
// CLICK CONFIRM
//
// From HTML: .picker-core__popup-footer > .picker-core__popup-footer-append
//              [class*='KsButton'][data-testid="core-index-xpDLeJ"] = Cancel  (first)
//              [class*='KsButton'][data-testid="core-index-g1HneZ"] = Confirm (last)
//                shadowRoot > <button>Confirm</button>
//
// RULES: NEVER click by suffix tag. NEVER click page-level buttons.
//        ALWAYS stay scoped inside .picker-core__popup-footer-append or .picker-core__popup.
// ════════════════════════════════════════════════════════

async function clickConfirm(page, onLog) {
  lg(onLog, "info", "   🗓️  Clicking Confirm...");

  // Helper: find .picker-core__popup-footer-append by walking all shadow roots
  // This is the stable container — class name never changes.
  function findFooterAppend(root) {
    const el = root.querySelector(".picker-core__popup-footer-append");
    if (el) return el;
    for (const c of root.querySelectorAll("*")) {
      if (c.shadowRoot) { const r = findFooterAppend(c.shadowRoot); if (r) return r; }
    }
    return null;
  }

  // Helper: given a footer element, click the element whose shadow/text says "Confirm".
  // Never clicks by position alone without a text check.
  function clickConfirmInFooter(footer) {
    // Collect all direct children that could be buttons (any tag with KsButton class)
    const candidates = [...footer.querySelectorAll("[class*='KsButton']")];
    for (const el of candidates) {
      if ((el.textContent || "").trim() === "Confirm") {
        const btn = el.shadowRoot ? el.shadowRoot.querySelector("button") : null;
        if (btn) { btn.click(); return "ksbutton-shadow"; }
        el.click(); return "ksbutton-host";
      }
    }
    // Also check plain <button> elements (in case shadow not used)
    for (const btn of footer.querySelectorAll("button")) {
      if ((btn.textContent || "").trim() === "Confirm") { btn.click(); return "plain-button"; }
    }
    return null;
  }

  // Try 1: footer-append → any KsButton/button with text "Confirm"
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
  lg(onLog, "info", `   🗓️  Confirm try 1 (footer-append + text Confirm): ${clicked}`);
  if (clicked && clicked !== "no-footer") { await page.waitForTimeout(500); return; }

  // Try 2: find .picker-core__popup, walk its entire subtree (including shadow roots)
  //         for any element with text "Confirm" — scoped so we never leave the popup
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
  lg(onLog, "info", `   🗓️  Confirm try 2 (picker-popup text walk): ${clicked}`);
  if (clicked && clicked !== "no-popup") { await page.waitForTimeout(500); return; }

  // Try 3: walk ALL shadow roots globally, find any [class*='KsButton'] with text "Confirm",
  //         verify it sits inside the picker popup by climbing the shadow host chain
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
  lg(onLog, "info", `   🗓️  Confirm try 3 (global scoped KsButton): ${clicked}`);
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
// READ SPEND — no suffix selectors anywhere
// ════════════════════════════════════════════════════════

async function waitForTable(page, ms, onLog) {
  lg(onLog, "info", "   💰 Waiting for table to load...");
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isLoginUrl(page.url())) {
      lg(onLog, "warn", "   ⚠️ Redirected to login while waiting for table");
      return "login";
    }
    const found = await page.evaluate(() => {
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
    if (found) { lg(onLog, "info", `   💰 Table found (${found})`); return found; }
    await page.waitForTimeout(600);
  }
  lg(onLog, "warn", `   💰 Table not found after ${ms/1000}s`);
  return null;
}

async function readSpend(page, onLog) {
  const tableResult = await waitForTable(page, 25000, onLog);
  if (tableResult === "login") return "SESSION_EXPIRED";

  lg(onLog, "info", "   💰 Reading spend...");

  // Try 1: div[slot="footer-stat_cost"] — find any leaf child with text
  let result = await page.evaluate(() => {
    const slotDiv = document.querySelector('div[slot="footer-stat_cost"]');
    if (!slotDiv) return { found: false, method: "no-slot-div" };
    for (const child of slotDiv.querySelectorAll("*")) {
      const t = child.textContent?.trim();
      if (t && t !== "—") return { found: true, text: t, method: "slot-child-text" };
    }
    const t = slotDiv.textContent?.trim();
    return (t && t !== "—") ? { found: true, text: t, method: "slot-div-text" } : { found: false, method: "empty-slot" };
  });
  lg(onLog, "info", `   💰 Try 1 (slot div): found=${result.found} method=${result.method} text="${result.text || ""}"`);
  if (result.found && result.text && result.text !== "—") return parseSpend(result.text);

  // Try 2: shadow walk for [slot="footer-stat_cost"]
  result = await page.evaluate(() => {
    function walk(root) {
      const slot = root.querySelector('[slot="footer-stat_cost"]');
      if (slot) {
        const t = slot.textContent?.trim();
        if (t && t !== "—") return { found: true, text: t, method: "shadow-slot" };
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

  // Try 3: tfoot with data-testid or slot containing "stat_cost"
  result = await page.evaluate(() => {
    const tfoot = document.querySelector("tfoot");
    if (!tfoot) return { found: false, method: "no-tfoot" };
    const th = tfoot.querySelector('[data-testid*="stat_cost"], [slot*="stat_cost"]');
    if (th) return { found: true, text: th.textContent?.trim(), method: "tfoot-testid" };
    const ths = [...tfoot.querySelectorAll("th")];
    const texts = ths.map(t => t.textContent?.trim()).filter(Boolean);
    return { found: texts.length > 0, text: texts.join(" | "), method: "tfoot-all-ths" };
  });
  lg(onLog, "info", `   💰 Try 3 (tfoot): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) {
    const m = result.text.match(/[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/);
    if (m) return parseSpend(m[0]);
  }

  // Try 4: any leaf element with currency pattern (tag-agnostic, no suffix)
  result = await page.evaluate(() => {
    function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        const t = el.textContent?.trim() || "";
        if (/[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/.test(t) && el.children.length === 0) {
          return { found: true, text: t, method: "leaf-currency" };
        }
        if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return r; }
      }
      return { found: false };
    }
    return walk(document);
  });
  lg(onLog, "info", `   💰 Try 4 (leaf currency): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  lg(onLog, "warn", "   💰 All spend methods failed — using 0");
  return 0;
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
        lg(onLog, "ok", "   ✅ Campaigns page ready — date picker found");
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
// SCRAPE ONE ACCOUNT
// ════════════════════════════════════════════════════════

async function scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog) {
  lg(onLog, "info", `   🌐 Account entry: ${accountUrl.slice(0, 80)}`);

  let cleanUrl = accountUrl;
  let aadvid = null;
  try {
    // Support two input formats:
    //   1. Plain numeric ID:  "7336115641021349890"
    //   2. Full URL:          "https://ads.tiktok.com/i18n/manage/campaign?aadvid=73361..."
    // In both cases we build a clean minimal URL with just the aadvid param,
    // so TikTok always lands on the current state of that account.
    const trimmed = accountUrl.trim();
    if (/^\d+$/.test(trimmed)) {
      // Plain numeric ID — build the URL directly
      aadvid   = trimmed;
      cleanUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${aadvid}`;
    } else {
      // Full URL — extract aadvid from query string
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

  lg(onLog, "info", "   📅 Setting date range...");
  await setDateRange(page, dateFrom, dateTo, onLog);

  // Guard: if Confirm accidentally navigated to campaign creation, recover
  const postDateUrl = page.url();
  if (postDateUrl.includes("/creation/") || postDateUrl.includes("/create/campaign")) {
    lg(onLog, "warn", `   ⚠️ Accidental navigation to campaign creation! Recovering...`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    await waitForCampaignsPage(page, aadvid, onLog);
    lg(onLog, "info", "   📅 Re-setting date range...");
    await setDateRange(page, dateFrom, dateTo, onLog);
  }

  lg(onLog, "info", "   💰 Reading spend...");
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
// MAIN — per-member entry point
// ════════════════════════════════════════════════════════

async function runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized, sharedPage, cancelToken }) {
  const fromDate = new Date(dateFrom);
  const toDate   = new Date(dateTo || dateFrom);

  const accounts = (member.tiktokAccounts || []).filter(a => a && a.trim() !== "");
  if (accounts.length === 0) {
    lg(onLog, "warn", `⚠️ No TikTok accounts for ${member.name}`);
    return { success: true, memberId: member.id, totalSpend: 0 };
  }

  lg(onLog, "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lg(onLog, "info", `🎵 TikTok: ${member.name} — ${accounts.length} account(s) [waiting for shared page...]`);
  lg(onLog, "info", `   Date: ${fromDate.toDateString()} → ${toDate.toDateString()}`);

  return withTiktokLock(async () => {
    const page = sharedPage || _sharedPage;
    if (!page) throw new Error("TikTok: shared Chrome page not initialised — call initSharedChrome first");

    lg(onLog, "info", `🎵 TikTok: ${member.name} — acquired shared page, scraping now`);

    try {
      if (cancelToken && cancelToken.cancelled) {
        lg(onLog, "warn", "⏹ Stop requested — TikTok skipping scrape.");
        return { success: true, memberId: member.id, totalSpend: 0 };
      }
      let totalSpend = 0;
      for (let i = 0; i < accounts.length; i++) {
        if (cancelToken && cancelToken.cancelled) {
          lg(onLog, "warn", "⏹ Stop requested — TikTok stopping account loop.");
          break;
        }
        lg(onLog, "info", `\n🎵 ── Account ${i + 1}/${accounts.length} ──`);
        try {
          const spend = await scrapeAccount(page, accounts[i], fromDate, toDate, onLog);
          totalSpend += (typeof spend === "number" ? spend : 0);
          lg(onLog, "ok", `🎵 Account ${i + 1}: ${spend} | Total so far: ${totalSpend}`);
        } catch (err) {
          lg(onLog, "warn", `⚠️ Account ${i + 1} error: ${err.message} — using 0`);
        }
      }

      lg(onLog, "ok", `✅ TikTok total for ${member.name}: ${totalSpend}`);
      return { success: true, memberId: member.id, totalSpend };

    } catch (err) {
      lg(onLog, "error", `❌ TikTok fatal [${member.name}]: ${err.message}`);
      return { success: false, memberId: member.id, totalSpend: 0, error: err.message };
    }
  });
}

function _getSharedPage() { return _sharedPage; }

module.exports = { runTikTok, initSharedChrome, closeSharedChrome, confirmInitialLogin, _getSharedPage };
