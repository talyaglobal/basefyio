#!/usr/bin/env node
/**
 * `geo` — zero-dependency CLI for the GEO toolkit.
 *
 *   geo audit <url> [--json]      Score a live URL for generative-engine readiness
 *   geo crawlers                  List the AI crawlers this toolkit knows about
 *   geo robots [--no-training]    Print an AI-crawler robots.txt policy block
 *
 * Kept dependency-free (no commander/chalk) so it installs instantly and runs
 * anywhere Node 18+ does.
 */
import { auditUrl } from './audit/index.js';
import { AI_CRAWLERS } from './crawlers.js';
import { aiCrawlerRules, renderRobotsRules } from './robots.js';
import type { AuditReport, CheckStatus } from './types.js';

// ── tiny ANSI helpers (respect NO_COLOR) ────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const statusMark: Record<CheckStatus, string> = {
  pass: green('✔'),
  warn: yellow('▲'),
  fail: red('✗'),
};

function gradeColor(grade: string): (s: string) => string {
  if (grade === 'A' || grade === 'B') return green;
  if (grade === 'C') return yellow;
  return red;
}

function printReport(report: AuditReport): void {
  const g = gradeColor(report.grade);
  console.log('');
  console.log(bold(`GEO audit — ${report.url}`));
  console.log(
    `${g(bold(`  ${report.grade}`))}  ${g(`${report.score}/100`)}  ${dim(
      `generative-engine readiness`,
    )}`,
  );
  console.log('');

  for (const cat of report.categories) {
    console.log(`${bold(cat.title)} ${dim(`(${cat.score}/${cat.max})`)}`);
    for (const ch of cat.checks) {
      console.log(`  ${statusMark[ch.status]} ${ch.title} ${dim(ch.detail)}`);
      if (ch.status !== 'pass' && ch.fix) {
        console.log(`      ${dim('→ ' + ch.fix)}`);
      }
    }
    console.log('');
  }

  if (report.recommendations.length) {
    console.log(bold('Top fixes'));
    report.recommendations.slice(0, 5).forEach((rec, i) => {
      console.log(`  ${cyan(String(i + 1) + '.')} ${rec}`);
    });
    console.log('');
  }
}

async function cmdAudit(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const url = args.find((a) => !a.startsWith('-'));
  if (!url) {
    console.error('Usage: geo audit <url> [--json]');
    return 1;
  }
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let report: AuditReport;
  try {
    report = await auditUrl(target);
  } catch (err) {
    console.error(red(`Audit failed: ${(err as Error).message}`));
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  return report.grade === 'F' ? 2 : 0;
}

function cmdCrawlers(): number {
  console.log('');
  console.log(bold('Known AI / generative-engine crawlers'));
  console.log('');
  const pad = Math.max(...AI_CRAWLERS.map((x) => x.token.length));
  for (const crawler of AI_CRAWLERS) {
    const tag =
      crawler.purpose === 'search'
        ? green('search')
        : crawler.purpose === 'user-action'
          ? cyan('user-action')
          : yellow('training');
    console.log(
      `  ${crawler.token.padEnd(pad)}  ${tag.padEnd(11)}  ${dim(
        `${crawler.operator} — ${crawler.label}`,
      )}`,
    );
  }
  console.log('');
  return 0;
}

function cmdRobots(args: string[]): number {
  const rules = aiCrawlerRules({
    allowTraining: !args.includes('--no-training'),
    allowSearch: !args.includes('--no-search'),
    allowUserActions: !args.includes('--no-user'),
  });
  process.stdout.write(renderRobotsRules(rules));
  return 0;
}

function help(): number {
  console.log(`
${bold('geo')} — Generative Engine Optimization toolkit

${bold('Usage')}
  geo audit <url> [--json]      Score a URL for generative-engine readiness
  geo crawlers                  List known AI crawlers and their purpose
  geo robots [flags]            Print an AI-crawler robots.txt policy
                                  --no-training  block model-training scrapers
                                  --no-search    block live answer engines
                                  --no-user      block on-demand browsing bots

${dim('Examples')}
  geo audit https://basefyio.com
  geo audit basefyio.com --json
  geo robots --no-training >> robots.txt
`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'audit':
      return cmdAudit(rest);
    case 'crawlers':
      return cmdCrawlers();
    case 'robots':
      return cmdRobots(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      return help();
    default:
      console.error(red(`Unknown command: ${cmd}`));
      help();
      return 1;
  }
}

main().then((code) => process.exit(code));
