/**
 * Search Console aggregation helpers.
 *
 * Average position is an impression-weighted mean: Google reports a row's
 * position as the average over that row's impressions. The plain mean of the
 * daily positions let a handful of near-empty days at position 1–2 pull the
 * headline to 2.8 while the page that got every impression sat at 7.1.
 */
export function weightedAveragePosition(rows: Array<{ impressions: number; position: number }>): number {
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    const i = Number(r.impressions) || 0;
    const p = Number(r.position) || 0;
    if (i <= 0 || p <= 0) continue;
    impressions += i;
    weighted += i * p;
  }
  return impressions > 0 ? Math.round((weighted / impressions) * 10) / 10 : 0;
}
