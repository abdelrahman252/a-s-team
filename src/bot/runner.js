"use strict";

/**
 * runner.js — Orchestrates the full bot run
 *
 * Members run sequentially (1 by 1) to avoid overwhelming Chrome
 * and to allow manual TikTok login per member when needed.
 *
 * Per member: Khod + TikTok run IN PARALLEL via Promise.all —
 * they use separate Chrome profiles (khod-{id} vs tiktok-{id})
 * so they never interfere with each other.
 *
 * Before: Khod → wait → TikTok → wait → next member
 * After:  Khod + TikTok simultaneously → next member
 */

const { runKhod }   = require("./khod");
const { runTikTok } = require("./tiktok");

function lg(onLog, type, msg) { onLog({ type, msg }); }

async function runForMembers({ teamConfig, members, dateFrom, dateTo, onLog, onProgress, launchMinimized }) {
  const selectedMembers = teamConfig.members.filter(m => members.includes(m.id));

  if (selectedMembers.length === 0) {
    throw new Error("No matching members found in config");
  }

  lg(onLog, "info", `🚀 A's Team Bot Starting`);
  lg(onLog, "info", `👥 Members: ${selectedMembers.map(m => m.name).join(", ")}`);
  lg(onLog, "info", `📅 Date: ${dateFrom}${dateTo !== dateFrom ? " → " + dateTo : ""}`);
  lg(onLog, "info", `⚡ Mode: Khod + TikTok running in parallel per member`);
  lg(onLog, "info", ``);

  const results = {};

  for (let i = 0; i < selectedMembers.length; i++) {
    const member = selectedMembers[i];

    onProgress({
      memberIndex: i,
      totalMembers: selectedMembers.length,
      memberId: member.id,
      memberName: member.name,
      phase: "starting",
    });

    lg(onLog, "info", `\n${"═".repeat(50)}`);
    lg(onLog, "info", `👤 [${i + 1}/${selectedMembers.length}] Starting: ${member.name}`);
    lg(onLog, "info", `${"═".repeat(50)}`);
    lg(onLog, "info", `⚡ Launching Khod + TikTok simultaneously...`);

    onProgress({
      memberId: member.id,
      memberName: member.name,
      phase: "running",
      step: "Khod + TikTok in parallel",
    });

    // ── Run Khod and TikTok at the same time ──
    // Each uses its own Chrome profile so sessions never conflict.
    // If one fails the other still completes — errors are caught inside each function.
    const [khodResult, tiktokResult] = await Promise.all([
      runKhod({ member, dateFrom, dateTo, onLog, launchMinimized }),
      runTikTok({ member, dateFrom, dateTo, onLog, launchMinimized }),
    ]);

    // ── Combine results ──
    const spend  = tiktokResult.totalSpend || 0;
    const orders = khodResult.totalOrders  || 0;
    const cpa    = orders > 0 && spend > 0 ? Math.round((spend / orders) * 100) / 100 : 0;

    results[member.id] = {
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
      memberId: member.id,
      memberName: member.name,
      phase: "done",
      result: results[member.id],
    });
  }

  lg(onLog, "info", `\n${"═".repeat(50)}`);
  lg(onLog, "ok", `🎉 All done! ${selectedMembers.length} member(s) processed.`);
  lg(onLog, "info", `${"═".repeat(50)}`);

  return results;
}

module.exports = { runForMembers };
