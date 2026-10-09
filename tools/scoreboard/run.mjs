#!/usr/bin/env node
/**
 * Scores basefyio against the benchmark's sixteen categories by reading the
 * tree, and prints where every verdict came from.
 *
 * The point is that the number cannot drift from the code. A hand-kept
 * scoreboard flatters whoever keeps it; this one fails the moment a capability
 * is claimed and not present, and it rises only when something is actually
 * built.
 *
 *   node tools/scoreboard/run.mjs              a table
 *   node tools/scoreboard/run.mjs --detail     every check, with citations
 *   node tools/scoreboard/run.mjs --json       machine-readable
 *   node tools/scoreboard/run.mjs --md         markdown, for the repo
 */
import { CATEGORIES } from './probes.mjs';

const argv = process.argv.slice(2);
const want = (f) => argv.includes(f);

const results = CATEGORIES.map((cat) => {
  const checks = cat.checks.map((c) => {
    let v;
    try {
      v = c.verdict();
    } catch (err) {
      v = { score: 0, evidence: `probe failed: ${err.message}` };
    }
    return { name: c.name, weight: c.weight, score: v.score, evidence: v.evidence };
  });
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + c.weight * c.score, 0);
  const score = total ? (earned / total) * 100 : 0;
  return { ...cat, checks, score, weighted: (score * cat.weight) / 100, rivalWeighted: (cat.rival * cat.weight) / 100 };
});

const ours = results.reduce((s, r) => s + r.weighted, 0);
const theirs = results.reduce((s, r) => s + r.rivalWeighted, 0);
const weights = results.reduce((s, r) => s + r.weight, 0);

if (want('--json')) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total: ours, rival: theirs, results }, null, 2));
  process.exit(0);
}

const bar = (n) => {
  const full = Math.round(n / 5);
  return '█'.repeat(full) + '·'.repeat(20 - full);
};
const pad = (s, n) => String(s).padEnd(n);
const num = (n, d = 1) => n.toFixed(d).padStart(5);

if (want('--md')) {
  console.log(`# basefyio capability scoreboard\n`);
  console.log(`Measured from the tree on ${new Date().toISOString().slice(0, 10)} by \`tools/scoreboard/run.mjs\`.`);
  console.log(`Weights are the benchmark's; the rival column is the score it assigns Supabase.\n`);
  console.log(`**Total: ${ours.toFixed(1)} / 100** (rival ${theirs.toFixed(1)})\n`);
  console.log('| # | Category | Weight | basefyio | Rival | Gap |');
  console.log('|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    console.log(
      `| ${i + 1} | ${r.name} | ${r.weight} | ${r.score.toFixed(0)} | ${r.rival} | ${(r.rival - r.score).toFixed(0)} |`,
    );
  });
  console.log(`\n## Checks\n`);
  for (const r of results) {
    console.log(`### ${r.name} — ${r.score.toFixed(0)}/100\n`);
    for (const c of r.checks) {
      const mark = c.score === 1 ? 'yes' : c.score === 0 ? 'no' : `${Math.round(c.score * 100)}%`;
      console.log(`- **${mark}** ${c.name} — ${c.evidence}`);
    }
    console.log('');
  }
  process.exit(0);
}

console.log('');
console.log(`  basefyio capability scoreboard — measured from the tree, ${new Date().toISOString().slice(0, 10)}`);
console.log('  ' + '─'.repeat(96));
console.log(`  ${pad('category', 36)} ${pad('score', 22)} ${pad('ours', 6)} ${pad('rival', 6)} ${pad('w.gap', 6)}`);
console.log('  ' + '─'.repeat(96));

for (const r of results) {
  const gap = r.rivalWeighted - r.weighted;
  console.log(
    `  ${pad(r.name.slice(0, 35), 36)} ${bar(r.score)} ${num(r.score, 0)}  ${num(r.rival, 0)}  ${num(gap, 1)}`,
  );
}

console.log('  ' + '─'.repeat(96));
console.log(
  `  ${pad('TOTAL (weights sum to ' + weights + ')', 36)} ${pad('', 22)} ${num(ours)}  ${num(theirs)}  ${num(theirs - ours)}`,
);
console.log('');

const byGap = [...results].sort((a, b) => b.rivalWeighted - b.weighted - (a.rivalWeighted - a.weighted));
console.log('  Largest weighted gaps — where a point costs least:');
for (const r of byGap.slice(0, 5)) {
  console.log(`    ${num(r.rivalWeighted - r.weighted)}  ${r.name}`);
}
console.log('');

if (want('--detail')) {
  for (const r of results) {
    console.log(`  ${r.name} — ${r.score.toFixed(0)}/100`);
    for (const c of r.checks) {
      const mark = c.score === 1 ? ' ok ' : c.score === 0 ? 'MISS' : `${String(Math.round(c.score * 100)).padStart(3)}%`;
      console.log(`    [${mark}] ${pad(c.name, 54)} ${c.evidence}`);
    }
    console.log('');
  }
}

const failing = results.flatMap((r) => r.checks.filter((c) => c.evidence.startsWith('probe failed')));
if (failing.length) {
  console.log(`  ${failing.length} probe(s) errored — the score is understated until they are fixed.`);
  process.exit(1);
}
