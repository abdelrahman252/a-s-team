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
 *
 * CHROME MODEL:
 *  Each TikTok account gets a fresh Chrome launch → scrape → close.
 *  No shared context or page. No mutex needed.
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
// CONTEXT REGISTRY — for force-kill on cancel
// ════════════════════════════════════════════════════════

const _activeContexts = new Set();

function _registerContext(ctx)   { _activeContexts.add(ctx); }
function _unregisterContext(ctx) { _activeContexts.delete(ctx); }

// ════════════════════════════════════════════════════════
// GLOBAL SERIAL QUEUE — one TikTok account at a time
// across ALL members (no two Chrome instances overlap)
// ════════════════════════════════════════════════════════

let _tiktokQueueTail = Promise.resolve();

function _enqueueTikTok(fn) {
  const next = _tiktokQueueTail.then(() => fn());
  // Swallow errors in the tail so one failure doesn't brick the queue
  _tiktokQueueTail = next.catch(() => {});
  return next;
}

async function closeAllActiveContexts(onLog) {
  const all = [..._activeContexts];
  _activeContexts.clear();
  for (const ctx of all) {
    try { await ctx.close(); } catch {}
  }
  if (all.length > 0) {
    lg(onLog, "info", `🔒 Force-closed ${all.length} active TikTok Chrome context(s).`);
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
      // Primary signal: the cost footer slot div exists in the live DOM
      if (document.querySelector('div[slot="footer-stat_cost"]')) return "slot";
      if (document.querySelector("tfoot")) return "tfoot";
      return null;
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

  // ── STRUCTURE (from real HTML snapshots) ─────────────────────────────────
  //  div[slot="footer-stat_cost"]          ← always in the light DOM
  //    ks-space-{suffix}                   ← custom element, shadowRoot = <slot>
  //    ks-text-{suffix}                    ← custom element, shadowRoot = <slot>
  //      [text node] "675.17 SAR"          ← the value we need
  //
  // .textContent on the ks-* host elements is EMPTY with declarative shadow DOM
  // (the text lives inside the shadow <slot>, not the light DOM tree).
  // Strategy: find div[slot="footer-stat_cost"], iterate its DIRECT children,
  // for each child read its shadowRoot's text nodes (where the real text lives),
  // and also fall back to innerText / textContent of the host itself.
  // ─────────────────────────────────────────────────────────────────────────

  // Try 1: shadowRoot text nodes of ks-text child inside the slot div
  let result = await page.evaluate(() => {
    const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;

    function extractTextFromNode(node) {
      // Walk all text nodes inside a given DOM node (including its shadowRoot)
      const texts = [];
      function collect(n) {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = n.textContent.trim();
          if (t) texts.push(t);
        }
        // Light DOM children
        for (const child of (n.childNodes || [])) collect(child);
        // Shadow DOM children
        if (n.shadowRoot) {
          for (const child of n.shadowRoot.childNodes) collect(child);
        }
      }
      collect(node);
      return texts.join(" ");
    }

    const slotDiv = document.querySelector('div[slot="footer-stat_cost"]');
    if (!slotDiv) return { found: false, method: "no-slot-div" };

    // Walk every descendant of slotDiv (light DOM only — custom elements)
    // and for each one also read its shadowRoot text nodes
    const allNodes = [slotDiv, ...slotDiv.querySelectorAll("*")];
    for (const node of allNodes) {
      const t = extractTextFromNode(node);
      if (CURRENCY_RE.test(t)) {
        return { found: true, text: t, method: "shadow-text-node" };
      }
    }

    return { found: false, method: "no-currency-found" };
  });
  lg(onLog, "info", `   💰 Try 1 (shadow text nodes): found=${result.found} method=${result.method} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  // Try 2: innerText on the slot div — works if Chromium resolves slotted text
  result = await page.evaluate(() => {
    const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
    const slotDiv = document.querySelector('div[slot="footer-stat_cost"]');
    if (!slotDiv) return { found: false, method: "no-slot-div" };
    const t = (slotDiv.innerText || "").trim();
    if (CURRENCY_RE.test(t)) return { found: true, text: t, method: "innerText" };
    return { found: false, method: "no-innerText-match" };
  });
  lg(onLog, "info", `   💰 Try 2 (innerText): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  // Try 3: tfoot — look for any th/td containing a currency amount
  result = await page.evaluate(() => {
    const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
    const tfoot = document.querySelector("tfoot");
    if (!tfoot) return { found: false, method: "no-tfoot" };
    for (const cell of tfoot.querySelectorAll("th, td")) {
      const t = (cell.innerText || cell.textContent || "").trim();
      if (CURRENCY_RE.test(t)) return { found: true, text: t, method: "tfoot-cell" };
    }
    return { found: false, method: "tfoot-no-match" };
  });
  lg(onLog, "info", `   💰 Try 3 (tfoot): found=${result.found} text="${result.text || ""}"`);
  if (result.found && result.text) return parseSpend(result.text);

  // Try 4: page-wide scan — find ANY element whose innerText matches a currency
  //         pattern AND is scoped near "stat_cost" in the DOM path (data-* or slot attr)
  result = await page.evaluate(() => {
    const CURRENCY_RE = /[\d,]+\.?\d*\s*(SAR|USD|EGP|AED)/;
    // Walk the full light DOM; for each element also check its shadowRoot children
    function collectTextNodes(root, out = []) {
      for (const el of root.querySelectorAll("*")) {
        // Check text nodes directly inside this element's shadowRoot
        if (el.shadowRoot) {
          for (const child of el.shadowRoot.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const t = child.textContent.trim();
              if (t && CURRENCY_RE.test(t)) out.push(t);
            }
          }
        }
        // Also check if the element itself (no shadow) has matching innerText
        if (!el.shadowRoot && !el.children.length) {
          const t = (el.textContent || "").trim();
          if (t && CURRENCY_RE.test(t)) out.push(t);
        }
      }
      return out;
    }
    const candidates = collectTextNodes(document);
    if (candidates.length > 0) return { found: true, text: candidates[0], method: "global-shadow-text" };
    return { found: false };
  });
  lg(onLog, "info", `   💰 Try 4 (global shadow scan): found=${result.found} text="${result.text || ""}"`);
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

  // Warmup: wake the page connection before real navigation
  lg(onLog, "info", "   🌐 Warming up page connection...");
  await page.goto("about:blank", { waitUntil: "commit", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);

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
// PER-ACCOUNT LAUNCH → SCRAPE → CLOSE  (with one retry)
// ════════════════════════════════════════════════════════

async function scrapeAccountWithChrome(accountUrl, dateFrom, dateTo, onLog, launchMinimized, profileKey) {
  // One attempt: launch, confirm login, scrape, close.
  // Returns spend (number) or throws.
  let context = null;
  try {
    const launched = await launchChrome(onLog, profileKey, launchMinimized);
    context = launched.context;
    _registerContext(context);
    const page = launched.page;

    await confirmInitialLogin(page, onLog);
    const spend = await scrapeAccount(page, accountUrl, dateFrom, dateTo, onLog);
    return spend;
  } finally {
    if (context) {
      _unregisterContext(context);
      await closeChrome(context, onLog);
    }
  }
}

// ════════════════════════════════════════════════════════
// MAIN — per-member entry point
// ════════════════════════════════════════════════════════

async function runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized, cancelToken }) {
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

      const accountIndex = i;
      const accountUrl   = accounts[i];

      // All accounts across all members share one profile (one saved session)
      // and are strictly serialised through the global queue — one Chrome at a time.
      const spend = await _enqueueTikTok(async () => {
        if (cancelToken && cancelToken.cancelled) {
          lg(onLog, "warn", "⏹ Stop requested — skipping queued account.");
          return 0;
        }

        lg(onLog, "info", `\n🎵 ── Account ${accountIndex + 1}/${accounts.length} (${member.name}) ──`);

        let result = 0;
        let succeeded = false;

        // First attempt — always use the shared profile so saved session is reused
        try {
          result = await scrapeAccountWithChrome(accountUrl, fromDate, toDate, onLog, launchMinimized, "tiktok-shared");
          result = typeof result === "number" ? result : 0;
          succeeded = true;
        } catch (err) {
          lg(onLog, "warn", `⚠️ Account ${accountIndex + 1} attempt 1 failed: ${err.message} — retrying once...`);
        }

        // One retry on failure
        if (!succeeded) {
          if (cancelToken && cancelToken.cancelled) {
            lg(onLog, "warn", "⏹ Stop requested — skipping retry.");
            return 0;
          }
          try {
            result = await scrapeAccountWithChrome(accountUrl, fromDate, toDate, onLog, launchMinimized, "tiktok-shared");
            result = typeof result === "number" ? result : 0;
            lg(onLog, "ok", `🎵 Account ${accountIndex + 1} retry succeeded.`);
          } catch (err2) {
            lg(onLog, "warn", `⚠️ Account ${accountIndex + 1} retry also failed: ${err2.message} — using 0`);
            result = 0;
          }
        }

        lg(onLog, "ok", `🎵 Account ${accountIndex + 1}: ${result}`);
        return result;
      });

      totalSpend += spend;
      lg(onLog, "ok", `🎵 Running total for ${member.name}: ${totalSpend}`);
    }

    lg(onLog, "ok", `✅ TikTok total for ${member.name}: ${totalSpend}`);
    return { success: true, memberId: member.id, totalSpend };

  } catch (err) {
    lg(onLog, "error", `❌ TikTok fatal [${member.name}]: ${err.message}`);
    return { success: false, memberId: member.id, totalSpend: 0, error: err.message };
  }
}

module.exports = { runTikTok, confirmInitialLogin, closeAllActiveContexts };