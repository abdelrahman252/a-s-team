"use strict";

/**
 * khod.js — Khod-Whaat affiliate bot
 *
 * Uses REAL Google Chrome via CDP attach (same as dashboard_tiktok browser.js).
 * Chrome is spawned with zero automation flags — TikTok/Khod see a normal browser.
 * Each member gets their own persistent Chrome profile so sessions are saved.
 *
 * Login URL  : https://khod-whaat.com/affiliate/auth/login
 * Date picker: flatpickr range — trigger: #from_date + input
 * Filter btn : button[name="filter"]
 * Export btn : button[name="export"]
 *
 * Sheet columns (0-indexed, same in /all and /delivered):
 *   14 = عدد القطع       (qty)
 *   19 = تاريخ الإنشاء   (created date — row filter)
 *   23 = المطلوب تحصيله  (delivered sheet only)
 */

const { launchChrome, closeChrome } = require("./browser");
const XLSX = require("xlsx");

const LOGIN_URL     = "https://khod-whaat.com/affiliate/auth/login";
const ALL_URL       = "https://khod-whaat.com/affiliate/orders/list/all";
const DELIVERED_URL = "https://khod-whaat.com/affiliate/orders/list/delivered";
const MONTH_NAMES   = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function lg(onLog, type, msg) { onLog({ type, msg }); }

// ── Parse date from sheet cell ──
function parseKhodDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === "number") return new Date(Math.round((val - 25569) * 86400 * 1000));
  const d = new Date(String(val).trim());
  return isNaN(d.getTime()) ? null : d;
}

function inRange(dateVal, from, to) {
  const d = parseKhodDate(dateVal);
  if (!d) return false;
  const day   = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end   = new Date(to.getFullYear(),   to.getMonth(),   to.getDate());
  return day >= start && day <= end;
}

function parseSheet(buffer, dateFrom, dateTo, isDelivered) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  let totalOrders = 0, qtySum = 0, qtyCount = 0, sumT = 0, tahseelCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 20) continue;
    if (!inRange(row[19], dateFrom, dateTo)) continue;
    totalOrders++;
    const qty = parseFloat(row[14]);
    if (!isNaN(qty) && qty > 0) { qtySum += qty; qtyCount++; }
    if (isDelivered) {
      const t = parseFloat(row[23]);
      if (!isNaN(t)) { sumT += t; tahseelCount++; }
    }
  }

  return {
    totalOrders,
    avgQty:     qtyCount > 0           ? Math.round(qtySum / qtyCount * 100) / 100 : 0,
    sumTahseel: isDelivered            ? Math.round(sumT * 100) / 100 : 0,
    avgTahseel: isDelivered && tahseelCount > 0 ? Math.round(sumT / tahseelCount * 100) / 100 : 0,
  };
}

// ── Flatpickr helpers (exact selectors from khodbot) ──
async function navigateFlatpickrToMonth(page, targetDate) {
  for (let i = 0; i < 24; i++) {
    const { month, year } = await page.evaluate(() => ({
      month: parseInt(document.querySelector(
        ".flatpickr-calendar.open .flatpickr-monthDropdown-months"
      )?.value ?? "-1"),
      year: parseInt(document.querySelector(
        ".flatpickr-calendar.open .numInput.cur-year"
      )?.value ?? "-1"),
    })).catch(() => ({ month: -1, year: -1 }));

    if (month === targetDate.getMonth() && year === targetDate.getFullYear()) break;

    const shownTotal  = year  * 12 + month;
    const targetTotal = targetDate.getFullYear() * 12 + targetDate.getMonth();
    if (targetTotal < shownTotal) {
      await page.click(".flatpickr-calendar.open .flatpickr-prev-month");
    } else {
      await page.click(".flatpickr-calendar.open .flatpickr-next-month");
    }
    await page.waitForTimeout(250); // was 300 — safe to tighten
  }
}

async function pickDateRange(page, dateFrom, dateTo, onLog) {
  const aria = d => `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  lg(onLog, "info", `📅 Setting date: ${aria(dateFrom)} → ${aria(dateTo)}`);

  await page.click("#from_date + input");
  await page.waitForSelector(".flatpickr-calendar.open", { timeout: 8000 });
  await page.waitForTimeout(200);

  await navigateFlatpickrToMonth(page, dateFrom);
  await page.click(`span.flatpickr-day[aria-label="${aria(dateFrom)}"]:not(.prevMonthDay):not(.nextMonthDay)`);
  await page.waitForTimeout(300);

  if (dateFrom.getMonth() !== dateTo.getMonth() || dateFrom.getFullYear() !== dateTo.getFullYear()) {
    await navigateFlatpickrToMonth(page, dateTo);
  }
  await page.click(`span.flatpickr-day[aria-label="${aria(dateTo)}"]:not(.prevMonthDay):not(.nextMonthDay)`);
  await page.waitForTimeout(300);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  lg(onLog, "ok", "✅ Date set");
}

async function filterAndExport(page, dateFrom, dateTo, onLog) {
  await page.waitForSelector("#from_date + input", { timeout: 15000 });

  // Session guard: if Khod redirected to login mid-run, throw so caller can retry
  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth")) {
    throw new Error("Khod session expired — redirected to login during export");
  }

  await pickDateRange(page, dateFrom, dateTo, onLog);

  lg(onLog, "info", "🔍 Clicking فلترة...");
  // Filter button — try selectors in order, stop at first match
  const filterSelectors = [
    'button[name="filter"]',
    'button:has-text("فلترة")',
    'button:has-text("Filter")',
    'input[type="submit"][value*="فلتر"]',
    'form button[type="submit"]',
  ];
  let filtered = false;
  for (const sel of filterSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        await page.locator(sel).first().click();
        filtered = true;
        lg(onLog, "info", `✅ Filter clicked via: ${sel}`);
        break;
      }
    } catch {}
  }
  if (!filtered) throw new Error("Filter button (فلترة) not found on page");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  try {
    const badge = await page.$eval(".badge.badge-soft-dark", el => el.innerText.trim());
    lg(onLog, "info", `📊 Orders: ${badge}`);
  } catch {}

  lg(onLog, "info", "📥 Clicking استخراج اكسل...");
  // Export button — try selectors in order, stop at first match
  const exportSelectors = [
    'button[name="export"]',
    'button:has-text("استخراج")',
    'button:has-text("اكسل")',
    'button:has-text("Excel")',
    'button:has-text("تصدير")',
    'a[href*="export"]',
  ];
  let exportFound = false;
  for (const sel of exportSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        lg(onLog, "info", `✅ Export button found via: ${sel}`);
        exportFound = true;
        const dlPromise = page.waitForEvent("download", { timeout: 15 * 60 * 1000 });
        await page.locator(sel).first().click({ noWaitAfter: true });
        lg(onLog, "info", "⏳ Waiting for download...");
        const dl     = await dlPromise;
        const stream = await dl.createReadStream();
        const chunks = [];
        await new Promise((res, rej) => {
          stream.on("data", c => chunks.push(c));
          stream.on("end", res);
          stream.on("error", rej);
        });
        const buffer = Buffer.concat(chunks);
        lg(onLog, "ok", `✅ Downloaded (${(buffer.length / 1024).toFixed(1)} KB)`);
        return buffer;
      }
    } catch (e) {
      lg(onLog, "warn", `⚠️ Selector "${sel}" failed: ${e.message}`);
    }
  }
  if (!exportFound) throw new Error("Export button not found on page");
}

// ══════════════════════════════════════════════
// MAIN EXPORT
// ══════════════════════════════════════════════
async function runKhod({ member, dateFrom, dateTo, onLog, launchMinimized }) {
  const fromDate = new Date(dateFrom);
  const toDate   = new Date(dateTo || dateFrom);

  lg(onLog, "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lg(onLog, "info", `👤 Khod-Whaat: ${member.name}`);

  // Launch real Chrome with member's own profile (anti-detection, persistent session)
  const { context, page } = await launchChrome(onLog, `khod-${member.id}`, launchMinimized);

  try {
    // ── Login ──
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    if (!page.url().includes("/login") && !page.url().includes("/auth")) {
      lg(onLog, "ok", "✅ Already logged in (saved session)");
    } else {
      lg(onLog, "info", `🔐 Logging in: ${member.name}...`);

      // Up to 3 reload attempts if login form fields not found
      for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
        try {
          if (loginAttempt > 1) {
            await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(2000);
          }
          await page.waitForSelector('input[name="email"]', { timeout: 8000 });
          await page.fill('input[name="email"]',    member.khodEmail);
          await page.waitForTimeout(300);
          await page.fill('input[name="password"]', member.khodPassword);
          await page.waitForTimeout(300);
          await page.click('button[type="submit"]');
          await page.waitForTimeout(1500);
          lg(onLog, "info", `🔐 Credentials submitted (attempt ${loginAttempt})`);
          break;
        } catch (e) {
          // Try phone field as fallback on attempt 2
          if (loginAttempt === 2) {
            try {
              await page.waitForSelector('input[name="phone"], input[name="phoneNumber"]', { timeout: 5000 });
              await page.fill('input[name="phone"], input[name="phoneNumber"]', member.khodEmail);
              await page.fill('input[name="password"]', member.khodPassword);
              await page.click('button[type="submit"]');
              await page.waitForTimeout(1500);
              break;
            } catch {}
          }
          if (loginAttempt < 3) {
            lg(onLog, "warn", `⚠️ Login fields not found (attempt ${loginAttempt}) — reloading...`);
            await page.waitForTimeout(2000);
          } else {
            lg(onLog, "warn", `⚠️ Login fields not found after 3 attempts — waiting for manual login`);
          }
        }
      }

      // Wait for redirect away from login (up to 5 min — handles 2FA / manual login)
      const deadline = Date.now() + 5 * 60 * 1000;
      let confirmed = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        const u = page.url();
        if (!u.includes("/login") && !u.includes("/auth")) { confirmed = true; break; }
        lg(onLog, "info", `⏳ Waiting for login (${Math.ceil((deadline - Date.now()) / 60000)}m left)...`);
      }
      if (!confirmed) throw new Error(`Khod login timeout for ${member.name}`);
      lg(onLog, "ok", "✅ Khod login confirmed");
    }

    // ── Phase A: All Orders ──
    lg(onLog, "info", `\n📋 Phase A: All orders`);
    await page.goto(ALL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    // Session guard: re-throw with clear message if session expired
    if (page.url().includes("/login") || page.url().includes("/auth")) {
      throw new Error("Khod session expired after navigating to orders page");
    }
    const allBuffer = await filterAndExport(page, fromDate, toDate, onLog);
    const allData   = parseSheet(allBuffer, fromDate, toDate, false);
    lg(onLog, "ok", `✅ All: ${allData.totalOrders} orders | Avg Qty: ${allData.avgQty}`);

    // ── Phase B: Delivered Orders ──
    lg(onLog, "info", `\n📦 Phase B: Delivered`);
    await page.goto(DELIVERED_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    // Session guard: re-throw with clear message if session expired
    if (page.url().includes("/login") || page.url().includes("/auth")) {
      throw new Error("Khod session expired after navigating to delivered orders page");
    }
    const delBuffer = await filterAndExport(page, fromDate, toDate, onLog);
    const delData   = parseSheet(delBuffer, fromDate, toDate, true);
    lg(onLog, "ok", `✅ Delivered: ${delData.totalOrders} | Sum: ${delData.sumTahseel} | Avg: ${delData.avgTahseel} | Qty: ${delData.avgQty}`);

    await closeChrome(context, onLog);

    return {
      success: true, memberId: member.id,
      totalOrders:     allData.totalOrders,
      avgQtyTotal:     allData.avgQty,
      deliveredOrders: delData.totalOrders,
      avgQtyDelivered: delData.avgQty,
      sumTahseel:      delData.sumTahseel,
      avgTahseel:      delData.avgTahseel,
    };

  } catch (err) {
    lg(onLog, "error", `❌ Khod error [${member.name}]: ${err.message}`);
    await closeChrome(context, onLog).catch(() => {});
    return {
      success: false, memberId: member.id, error: err.message,
      totalOrders: 0, avgQtyTotal: 0, deliveredOrders: 0,
      avgQtyDelivered: 0, sumTahseel: 0, avgTahseel: 0,
    };
  }
}

module.exports = { runKhod };
