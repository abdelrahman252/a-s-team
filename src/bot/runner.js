"use strict";

/**
 * runner.js — Orchestrates the full bot run
 *
 * PARALLELISM MODEL (v6):
 * ──────────────────────
 *  • ALL members run in parallel via Promise.allSettled().
 *  • PER MEMBER: Khod + TikTok also run in parallel via Promise.all().
 *  • Result: if you have 4 members the whole run takes as long as the
 *    SLOWEST single member, not the sum of all members.
 *
 * CHROME INSTANCES:
 * ─────────────────
 *  • Khod  → 1 Chrome per member  (profile: khod-{id})  — run in parallel.
 *  • TikTok → 1 SHARED Chrome     (profile: tiktok-shared) — shared across
 *    all members. TikTok accounts are scraped one at a time inside that one
 *    window so there are no race conditions on the shared page.
 *
 * CANCEL:
 * ───────
 *  • CancelToken is checked before the parallel batch starts.
 *  • Individual Khod tasks propagate the cancellation naturally.
 */

const { runKhod }  = require("./khod");
const {
  runTikTok,
  initSharedChrome,
  closeSharedChrome,
  confirmInitialLogin,
  _getSharedPage,
} = require("./tiktok");

function lg(onLog, type, msg) { onLog({ type, msg }); }

// ─────────────────────────────────────────────────────────
// CancelToken
// ─────────────────────────────────────────────────────────
class CancelToken {
  constructor() { this.cancelled = false; }
  cancel()       { this.cancelled = true; }
  throwIfCancelled() {
    if (this.cancelled) throw new Error("Bot stopped by user");
  }
}

// ─────────────────────────────────────────────────────────
// Process one member (Khod + TikTok in parallel)
// ─────────────────────────────────────────────────────────
async function processMember({ member, dateFrom, dateTo, onLog, onProgress, launchMinimized, cancelToken, memberIndex, totalMembers }) {
  const token = cancelToken || new CancelToken();
  token.throwIfCancelled();

  onProgress({
    memberIndex,
    totalMembers,
    memberId:   member.id,
    memberName: member.name,
    phase:      "running",
    step:       "Khod + TikTok in parallel",
  });

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "info", `👤 [${memberIndex + 1}/${totalMembers}] Starting: ${member.name}`);
  lg(onLog, "info", `${"═".repeat(50)}`);
  lg(onLog, "info", `⚡ Launching Khod + TikTok simultaneously...`);

  // Khod gets its own Chrome; TikTok reuses the shared one
  const [khodResult, tiktokResult] = await Promise.all([
    runKhod({ member, dateFrom, dateTo, onLog, launchMinimized, cancelToken: token }),
    runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized, cancelToken: token }),
  ]);

  const spend  = tiktokResult.totalSpend || 0;
  const orders = khodResult.totalOrders  || 0;
  const cpa    = orders > 0 && spend > 0
    ? Math.round((spend / orders) * 100) / 100
    : 0;

  const result = {
    memberId:        member.id,
    memberName:      member.name,
    spend,
    totalOrders:     orders,
    avgQtyTotal:     khodResult.avgQtyTotal     || 0,
    cpa,
    deliveredOrders: khodResult.deliveredOrders || 0,
    avgQtyDelivered: khodResult.avgQtyDelivered || 0,
    sumTahseel:      khodResult.sumTahseel      || 0,
    avgTahseel:      khodResult.avgTahseel      || 0,
    khodSuccess:     khodResult.success,
    tiktokSuccess:   tiktokResult.success,
  };

  lg(onLog, "ok", `\n✅ ${member.name} complete:`);
  lg(onLog, "ok", `   💰 Spend: ${spend}`);
  lg(onLog, "ok", `   📦 Orders: ${orders} | CPA: ${cpa}`);
  lg(onLog, "ok", `   ✅ Delivered: ${khodResult.deliveredOrders} | Sum تحصيله: ${khodResult.sumTahseel}`);

  onProgress({
    memberId:   member.id,
    memberName: member.name,
    phase:      "done",
    result,
  });

  return result;
}

// ─────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────
async function runForMembers({ teamConfig, members, dateFrom, dateTo, onLog, onProgress, launchMinimized, cancelToken }) {
  const token = cancelToken || new CancelToken();
  const selectedMembers = teamConfig.members.filter(m => members.includes(m.id));

  if (selectedMembers.length === 0) {
    throw new Error("No matching members found in config");
  }

  token.throwIfCancelled();

  lg(onLog, "info", `🚀 A's Team Bot Starting`);
  lg(onLog, "info", `👥 Members: ${selectedMembers.map(m => m.name).join(", ")}`);
  lg(onLog, "info", `📅 Date: ${dateFrom}${dateTo !== dateFrom ? " → " + dateTo : ""}`);
  lg(onLog, "info", `⚡ Mode: ALL members in parallel — Khod + TikTok parallel per member`);
  lg(onLog, "info", `🌐 Chrome: 1 Khod window per member (parallel) + 1 shared TikTok window`);
  lg(onLog, "info", ``);

  // ── Does any selected member have TikTok accounts? ──
  const hasTikTok = selectedMembers.some(m =>
    (m.tiktokAccounts || []).some(a => a && a.trim() !== "")
  );

  // ── Init shared TikTok Chrome ONCE — before any member starts ──
  if (hasTikTok) {
    lg(onLog, "info", "🌐 Initialising shared TikTok Chrome...");
    await initSharedChrome(onLog, launchMinimized);

    const sharedPage = _getSharedPage();
    if (sharedPage) {
      await confirmInitialLogin(sharedPage, onLog);
    }
  }

  // ── Emit "starting" progress for every member up front ──
  selectedMembers.forEach((member, i) => {
    onProgress({
      memberIndex:  i,
      totalMembers: selectedMembers.length,
      memberId:     member.id,
      memberName:   member.name,
      phase:        "starting",
    });
  });

  // ── Launch ALL members in parallel ──
  lg(onLog, "info", `\n🚀 Launching all ${selectedMembers.length} member(s) in parallel...`);

  const memberPromises = selectedMembers.map((member, i) =>
    processMember({
      member,
      dateFrom,
      dateTo,
      onLog,
      onProgress,
      launchMinimized,
      cancelToken:  token,
      memberIndex:  i,
      totalMembers: selectedMembers.length,
    })
  );

  // allSettled — one failure doesn't abort the others
  const settled = await Promise.allSettled(memberPromises);

  // ── Close shared TikTok Chrome after ALL members finish ──
  if (hasTikTok) {
    lg(onLog, "info", "🔒 Closing shared TikTok Chrome...");
    await closeSharedChrome(onLog);
  }

  // ── Collect results ──
  const results = {};
  settled.forEach((outcome, i) => {
    const member = selectedMembers[i];
    if (outcome.status === "fulfilled") {
      results[member.id] = outcome.value;
    } else {
      lg(onLog, "error", `❌ ${member.name} failed: ${outcome.reason?.message || outcome.reason}`);
      results[member.id] = {
        memberId:        member.id,
        memberName:      member.name,
        spend:           0,
        totalOrders:     0,
        avgQtyTotal:     0,
        cpa:             0,
        deliveredOrders: 0,
        avgQtyDelivered: 0,
        sumTahseel:      0,
        avgTahseel:      0,
        khodSuccess:     false,
        tiktokSuccess:   false,
        error:           outcome.reason?.message || String(outcome.reason),
      };
      onProgress({
        memberId:   member.id,
        memberName: member.name,
        phase:      "done",
        result:     results[member.id],
      });
    }
  });

  const successCount = settled.filter(o => o.status === "fulfilled").length;

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "ok",   `🎉 All done! ${successCount}/${selectedMembers.length} member(s) succeeded.`);
  lg(onLog, "info", `${"═".repeat(50)}`);

  return results;
}

module.exports = { runForMembers, CancelToken };
