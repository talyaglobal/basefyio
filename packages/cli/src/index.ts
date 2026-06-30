#!/usr/bin/env node
import { execSync } from 'node:child_process';
import {
  allPassed,
  formatChecks,
  runDoctor,
  type DoctorEnv,
} from './doctor';
import { resolveVersion } from './version';

function hasDocker(): boolean {
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function probeApi(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

const USAGE = `basefyio — CLI for the basefyio platform

Usage:
  basefyio <command> [options]

Commands:
  doctor            Check your local environment
  help              Show this help

Options:
  -v, --version     Print the CLI version
  -h, --help        Show this help
`;

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;

  switch (cmd) {
    case '-v':
    case '--version':
      process.stdout.write(`${resolveVersion()}\n`);
      return 0;

    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;

    case 'doctor': {
      const apiUrl = process.env.BASEFYIO_API_URL;
      const env: DoctorEnv = {
        nodeVersion: process.version,
        hasDocker: hasDocker(),
        apiUrl,
        apiReachable: apiUrl ? await probeApi(apiUrl) : null,
      };
      const checks = runDoctor(env);
      process.stdout.write(`${formatChecks(checks)}\n`);
      return allPassed(checks) ? 0 : 1;
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
