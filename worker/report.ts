/**
 * Image-processing cost and quality report, from the processing record stored on each item.
 * Shows whether the local-first pipeline is working: how many images needed no processing,
 * how many the free local model handled (and its gate accepted), how many went to Replicate
 * and whether the paid result passed, why, what it cost and what it saved, and the final
 * statuses merchants saw. GET /internal/metrics answers the same summary as JSON.
 *
 *   npm run report:processing -- [--days 7] [--shop <domain>] [--job <id>] [--json]
 *   On the VPS: docker compose -f docker-compose.vps.yml exec worker npm run report:processing -- --days 7
 */
import "./bootstrap-env";
import prisma from "../app/db.server";
import { groupByDay, loadProcessingRows, summarize } from "../app/lib/metrics.server";
import type { ProcessingSummary } from "../app/lib/processing";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null, d = 4) => (x === null ? "-" : `$${x.toFixed(d)}`);

function line(label: string, s: ProcessingSummary): string {
  const methods = Object.entries(s.byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m} ${n}`)
    .join(", ");
  return [
    label.padEnd(26),
    `${String(s.images).padStart(5)} images`,
    `${(s.replicateShare * 100).toFixed(1).padStart(5)}% used Replicate`,
    `${String(s.replicateCalls).padStart(4)} calls`,
    `$${s.estimatedUsd.toFixed(4).padStart(8)}`,
    `$${s.usdPerImage.toFixed(5)}/image`,
    `avg ${s.avgDurationMs ?? "-"} ms`,
    `quality ${s.avgQuality ?? "-"}`,
    `${s.failed} failed`,
    `[${methods}]`,
  ].join("  ");
}

/** The cost dashboard: the local-first funnel, what it cost and what it saved. */
function dashboard(s: ProcessingSummary): string[] {
  const f = s.finalStatuses;
  return [
    `Images analyzed              ${s.analyzed}   (+ ${s.reused} reused from an identical earlier result)`,
    `No processing required       ${s.noChange}   (NO_CHANGE: already clean)`,
    `Local attempted              ${s.localAttempted}`,
    `  accepted (gate SAFE_LOCAL) ${s.localAccepted}   local acceptance rate ${pct(s.localAcceptanceRate)}`,
    `  rejected by the gate       ${s.localRejected}`,
    `  safe but paid result used  ${s.localSafeNotUsed}   (shadow mode, rollout or merchant's stronger model)`,
    `Sent to Replicate            ${s.sentToReplicate}   Replicate usage ${pct(s.replicateUsage)}`,
    `  passed (ai_gate PASS)      ${s.replicatePassed}`,
    `  rejected (UNSAFE)          ${s.replicateRejected}`,
    `Avg Replicate cost / image   ${usd(s.avgReplicateUsdPerImage, 5)}   (images that used it)`,
    `Total estimated cost         ${usd(s.estimatedUsd)}   (${s.supersededRuns} earlier runs replaced by "Retry with stronger model" included)`,
    `Estimated spend avoided      ${usd(s.spendAvoidedUsd)}   ((local accepted + no change) × ${usd(s.avgReplicateCutoutUsd, 5)} per cut-out, ${s.avgReplicateCutoutUsdSource})`,
    `Final status                 READY ${f.READY} · NEEDS_REVIEW ${f.NEEDS_REVIEW} · NO_CHANGE ${f.NO_CHANGE} · FAILED ${f.FAILED}`,
    `Retried with stronger model  ${s.forcedByMerchant}`,
    `Shadow mode                  ${s.shadow.count} images` +
      (s.shadow.count
        ? `, local would have been used ${pct(s.shadow.localWouldHaveBeenUsedRate)}, mean IoU local vs final ${s.shadow.meanIou ?? "-"}`
        : ""),
  ];
}

async function main() {
  const days = Number(arg("days") ?? 7);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await loadProcessingRows({ since, shopDomain: arg("shop"), jobId: arg("job") });
  const overall = summarize(rows);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ since, overall }, null, 2));
    return;
  }

  console.log(`Image processing since ${since.toISOString().slice(0, 10)} (${days} days)\n`);
  console.log(line("All", overall));
  console.log("\nCost dashboard:");
  for (const l of dashboard(overall)) console.log(`  ${l}`);
  console.log(`\nTop reason codes: ${overall.topReasonCodes.length ? "" : "none"}`);
  for (const { code, count } of overall.topReasonCodes) console.log(`  ${String(count).padStart(5)}  ${code}`);
  const reasons = Object.entries(overall.fallbackReasons).sort((a, b) => b[1] - a[1]);
  console.log(`\nWhy Replicate was used (or skipped): ${reasons.length ? "" : "never"}`);
  for (const [reason, n] of reasons) console.log(`  ${String(n).padStart(5)}  ${reason}`);

  const byJob = new Map<string, typeof rows>();
  for (const row of rows) byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row]);
  console.log("\nBy day:");
  for (const [day, dayRows] of groupByDay(rows)) console.log(line(day, summarize(dayRows)));
  console.log("\nLatest jobs:");
  for (const [jobId, jobRows] of [...byJob].slice(0, 20)) console.log(line(jobId, summarize(jobRows)));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
