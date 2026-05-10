"use strict";

/**
 * runner.js — Orchestrates the full bot run
 *
 * PARALLELISM MODEL:
 * ──────────────────
 *  • Members run in parallel up to teamConfig.maxParallelMembers (default 3).
 *  • A proper semaphore — as soon as one member finishes the next starts.
 *  • PER MEMBER: Khod + TikTok run in parallel via Promise.all().
 *
 * CHROME INSTANCES:
 * ─────────────────
 *  • Khod   → 1 Chrome per member (profile: khod-{id})
 *  • TikTok → 1 fresh Chrome PER ACCOUNT — launched, scraped, then closed.
 *    No shared TikTok Chrome. No mutex.
 *
 * CANCEL / FORCE-KILL:
 * ────────────────────
 *  • Pressing Stop sets cancelToken.cancelled = true AND immediately
 *    calls closeAllActiveContexts() to force-close every live TikTok
 *    Chrome context without waiting for them to cooperate.
 */

const { runKhod }  = require("./khod");
const { runTikTok, closeAllActiveContexts } = require("./tiktok");

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
// Semaphore — limits concurrent member processing
// ─────────────────────────────────────────────────────────
class Semaphore {
  constructor(max) {
    this._max     = max;
    this._current = 0;
    this._queue   = [];
  }

  async acquire() {
    if (this._current < this._max) {
      this._current++;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
    this._current++;
  }

  release() {
    this._current--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    }
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

  // Khod gets its own Chrome; TikTok launches a fresh Chrome per account
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

  const maxParallel = (teamConfig.maxParallelMembers && teamConfig.maxParallelMembers > 0)
    ? teamConfig.maxParallelMembers
    : 3;

  lg(onLog, "info", `🚀 A's Team Bot Starting`);
  lg(onLog, "info", `👥 Members: ${selectedMembers.map(m => m.name).join(", ")}`);
  lg(onLog, "info", `📅 Date: ${dateFrom}${dateTo !== dateFrom ? " → " + dateTo : ""}`);
  lg(onLog, "info", `⚡ Mode: up to ${maxParallel} member(s) in parallel — Khod + TikTok parallel per member`);
  lg(onLog, "info", `🌐 Chrome: 1 Khod window per member + 1 fresh TikTok Chrome per account`);
  lg(onLog, "info", ``);

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

  // ── Launch members via semaphore ──
  lg(onLog, "info", `\n🚀 Launching ${selectedMembers.length} member(s) with max ${maxParallel} in parallel...`);

  const sem = new Semaphore(maxParallel);

  const memberPromises = selectedMembers.map((member, i) =>
    (async () => {
      await sem.acquire();
      try {
        return await processMember({
          member,
          dateFrom,
          dateTo,
          onLog,
          onProgress,
          launchMinimized,
          cancelToken:  token,
          memberIndex:  i,
          totalMembers: selectedMembers.length,
        });
      } finally {
        sem.release();
      }
    })()
  );

  // allSettled — one failure doesn't abort the others
  const settled = await Promise.allSettled(memberPromises);

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

// ─────────────────────────────────────────────────────────
// STOP — force-kill all active Chrome contexts immediately
// ─────────────────────────────────────────────────────────
async function stopBot(cancelToken, onLog) {
  if (cancelToken) cancelToken.cancel();
  lg(onLog, "warn", "⏹ Stop requested — force-closing all active Chrome contexts...");
  await closeAllActiveContexts(onLog);
  lg(onLog, "warn", "⏹ All Chrome contexts closed.");
}

module.exports = { runForMembers, CancelToken, stopBot };