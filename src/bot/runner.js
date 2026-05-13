"use strict";

/**
 * runner.js — Orchestrates the full bot run
 *
 * PARALLELISM MODEL:
 * ──────────────────
 *  • Khod   → ALL members in parallel (each has its own profile, no conflict).
 *  • TikTok → ALL accounts from ALL members collected into one flat queue,
 *             then run ONE BY ONE sequentially — open Chrome → scrape → close
 *             → next. Only ever one Chrome touching "tiktok-shared" at a time.
 *
 * WHY THIS FIXES THE CRASH:
 * ─────────────────────────
 *  The old model ran one TikTok chain per member in parallel. Because every
 *  chain used the same "tiktok-shared" Chrome profile, 5 Chrome processes
 *  tried to open the same profile simultaneously → Chrome detected an existing
 *  session → "Opening in existing browser session" → process died →
 *  "Target page, context or browser has been closed".
 *
 *  The new model guarantees only ONE Chrome instance touches "tiktok-shared"
 *  at any point, eliminating the conflict entirely. No profile duplication,
 *  no cookie copying, no login needed — Business Center login is shared
 *  naturally because it's the same profile, used sequentially.
 *
 * CHROME INSTANCES:
 * ─────────────────
 *  • Khod   → 1 Chrome per member (profile: khod-{id}) — all parallel.
 *  • TikTok → 1 Chrome per account, sequential across ALL members.
 *             launch → scrape → fully close → launch next account.
 *
 * RESULT ASSEMBLY:
 * ────────────────
 *  Each TikTok account carries its memberId so spend is summed back
 *  to the correct member after the global queue finishes.
 *
 * CANCEL:
 * ───────
 *  CancelToken is checked before each account in the TikTok queue
 *  and propagated into Khod runners.
 */

const { runKhod }                      = require("./khod");
const { scrapeOneAccount }             = require("./tiktok");
const { killAllChrome }                = require("./browser");

function lg(onLog, type, msg) { onLog({ type, msg }); }

// ─────────────────────────────────────────────────────────
// CancelToken
//
// cancel() does two things:
//  1. Sets the flag so loop checks bail immediately
//  2. Force-closes ALL open Chrome instances right now
//     — no waiting for the current scrape step to finish
// ─────────────────────────────────────────────────────────
class CancelToken {
  constructor() {
    this.cancelled = false;
    this._onLog    = null; // set by runForMembers
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    killAllChrome(this._onLog).catch(() => {});
  }
  throwIfCancelled() {
    if (this.cancelled) throw new Error("Bot stopped by user");
  }
}

// ─────────────────────────────────────────────────────────
// Run Khod for one member
// ─────────────────────────────────────────────────────────
async function processKhod({ member, dateFrom, dateTo, onLog, onProgress, launchMinimized, cancelToken, memberIndex, totalMembers }) {
  onProgress({
    memberIndex,
    totalMembers,
    memberId:   member.id,
    memberName: member.name,
    phase:      "running",
    step:       "Khod",
  });

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "info", `👤 [${memberIndex + 1}/${totalMembers}] Khod starting: ${member.name}`);
  lg(onLog, "info", `${"═".repeat(50)}`);

  try {
    const khodResult = await runKhod({ member, dateFrom, dateTo, onLog, launchMinimized, cancelToken });
    return { memberId: member.id, memberName: member.name, khodResult };
  } catch (err) {
    lg(onLog, "error", `❌ Khod failed [${member.name}]: ${err.message}`);
    return {
      memberId:   member.id,
      memberName: member.name,
      khodResult: {
        success:         false,
        totalOrders:     0,
        avgQtyTotal:     0,
        deliveredOrders: 0,
        avgQtyDelivered: 0,
        sumTahseel:      0,
        avgTahseel:      0,
        error:           err.message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// Run ALL TikTok accounts sequentially (global queue)
// ─────────────────────────────────────────────────────────
async function runTikTokQueue({ accountQueue, dateFrom, dateTo, onLog, launchMinimized, cancelToken }) {
  const totalAccounts = accountQueue.length;

  // spendByMember: { memberId: number }
  const spendByMember = {};
  for (const { memberId } of accountQueue) {
    spendByMember[memberId] = 0;
  }

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "info", `🎵 TikTok Queue — ${totalAccounts} account(s) total, sequential`);
  lg(onLog, "info", `   Mode: launch Chrome → scrape → close → next account`);
  lg(onLog, "info", `${"═".repeat(50)}`);

  for (let i = 0; i < accountQueue.length; i++) {
    if (cancelToken && cancelToken.cancelled) {
      lg(onLog, "warn", "⏹ Stop requested — TikTok queue terminating immediately.");
      throw new Error("Bot stopped by user");
    }

    const { memberId, memberName, accountId } = accountQueue[i];
    lg(onLog, "info", `\n🎵 ── [${i + 1}/${totalAccounts}] ${memberName} → ${accountId} ──`);

    const spend = await scrapeOneAccount({
      accountId,
      dateFrom,
      dateTo,
      onLog,
      launchMinimized,
    });

    spendByMember[memberId] = (spendByMember[memberId] || 0) + spend;
    lg(onLog, "ok", `🎵 Account done: ${spend} | ${memberName} running total: ${spendByMember[memberId]}`);
  }

  lg(onLog, "info", `\n✅ TikTok queue complete.`);
  return spendByMember;
}

// ─────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────
async function runForMembers({ teamConfig, members, dateFrom, dateTo, onLog, onProgress, launchMinimized, cancelToken }) {
  const token = cancelToken || new CancelToken();
  token._onLog = onLog; // so kill switch can log
  const selectedMembers = teamConfig.members.filter(m => members.includes(m.id));

  if (selectedMembers.length === 0) {
    throw new Error("No matching members found in config");
  }

  token.throwIfCancelled();

  lg(onLog, "info", `🚀 A's Team Bot Starting`);
  lg(onLog, "info", `👥 Members: ${selectedMembers.map(m => m.name).join(", ")}`);
  lg(onLog, "info", `📅 Date: ${dateFrom}${dateTo !== dateFrom ? " → " + dateTo : ""}`);
  lg(onLog, "info", `⚡ Mode: Khod (all members parallel) + TikTok (all accounts sequential) — both run at the same time`);
  lg(onLog, "info", `🌐 Khod: 1 Chrome per member (parallel) | TikTok: 1 Chrome per account (sequential, never overlapping)`);
  lg(onLog, "info", ``);

  // Emit "starting" progress for every member up front
  selectedMembers.forEach((member, i) => {
    onProgress({
      memberIndex:  i,
      totalMembers: selectedMembers.length,
      memberId:     member.id,
      memberName:   member.name,
      phase:        "starting",
    });
  });

  // ── Build TikTok queue upfront (needs no Chrome, just config) ──
  const accountQueue = [];
  for (const member of selectedMembers) {
    const accounts = (member.tiktokAccounts || []).filter(a => a && a.trim() !== "");
    if (accounts.length === 0) {
      lg(onLog, "warn", `⚠️ No TikTok accounts for ${member.name} — skipping TikTok`);
    }
    for (const accountId of accounts) {
      accountQueue.push({ memberId: member.id, memberName: member.name, accountId });
    }
  }

  // ── Launch BOTH phases simultaneously ──────────────────
  lg(onLog, "info", `\n🚀 Launching ${selectedMembers.length} Khod runner(s) + ${accountQueue.length} TikTok account(s) simultaneously...`);

  const khodPromises = selectedMembers.map((member, i) =>
    processKhod({
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

  const tiktokPromise = accountQueue.length > 0
    ? runTikTokQueue({ accountQueue, dateFrom, dateTo, onLog, launchMinimized, cancelToken: token })
    : Promise.resolve({});

  // Wait for BOTH to finish before assembling results
  const [khodSettled, spendByMemberRaw] = await Promise.all([
    Promise.allSettled(khodPromises),
    tiktokPromise,
  ]);

  // Build khodResults map: memberId → khodResult
  const khodResultMap = {};
  khodSettled.forEach((outcome, i) => {
    const member = selectedMembers[i];
    if (outcome.status === "fulfilled") {
      khodResultMap[member.id] = outcome.value.khodResult;
    } else {
      lg(onLog, "error", `❌ Khod [${member.name}] threw: ${outcome.reason?.message || outcome.reason}`);
      khodResultMap[member.id] = {
        success: false, totalOrders: 0, avgQtyTotal: 0,
        deliveredOrders: 0, avgQtyDelivered: 0, sumTahseel: 0, avgTahseel: 0,
        error: outcome.reason?.message || String(outcome.reason),
      };
    }
  });

  const spendByMember = spendByMemberRaw || {};

  // ── Assemble final results ──────────────────────────────
  const results = {};
  for (const member of selectedMembers) {
    const khodResult = khodResultMap[member.id] || {};
    const spend      = spendByMember[member.id]  || 0;
    const orders     = khodResult.totalOrders     || 0;
    const cpa        = orders > 0 && spend > 0
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
      khodSuccess:     khodResult.success         || false,
      tiktokSuccess:   spend > 0 || (member.tiktokAccounts || []).length === 0,
    };

    results[member.id] = result;

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
  }

  const successCount = Object.values(results).filter(r => r.khodSuccess).length;

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "ok",   `🎉 All done! ${successCount}/${selectedMembers.length} member(s) Khod succeeded.`);
  lg(onLog, "info", `${"═".repeat(50)}`);

  return results;
}

module.exports = { runForMembers, CancelToken };
