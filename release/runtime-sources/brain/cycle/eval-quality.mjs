import { brainPost } from '../brain-client.mjs';

export async function evalQuality(previousReport) {
  const replay = await brainPost('/eval/replay', { limit: Number(process.env.BRAIN_CYCLE_EVAL_LIMIT ?? 200) }, { strict: false });
  const summary = replay.data?.summary ?? {};
  const previous = previousReport?.eval_quality?.summary ?? {};
  const warnings = [];

  for (const [route, stats] of Object.entries(summary)) {
    if (stats.sourceCoverage < 0.5) warnings.push(`${route} source coverage is low (${stats.sourceCoverage})`);
    if (stats.acceptanceRecall != null && stats.acceptanceRecall < 0.6) warnings.push(`${route} acceptance recall is low (${stats.acceptanceRecall})`);
    const prev = previous[route];
    if (prev?.sourceCoverage != null && stats.sourceCoverage < prev.sourceCoverage - 0.2) {
      warnings.push(`${route} source coverage dropped from ${prev.sourceCoverage} to ${stats.sourceCoverage}`);
    }
    if (prev?.acceptanceRecall != null && stats.acceptanceRecall != null && stats.acceptanceRecall < prev.acceptanceRecall - 0.2) {
      warnings.push(`${route} acceptance recall dropped from ${prev.acceptanceRecall} to ${stats.acceptanceRecall}`);
    }
  }

  return { summary, warnings };
}
