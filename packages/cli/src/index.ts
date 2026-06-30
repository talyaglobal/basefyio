#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  allPassed,
  formatChecks,
  runDoctor,
  type DoctorEnv,
} from './doctor';
import { resolveVersion } from './version';
import { loadConfig, saveConfig } from './config';
import { makeClient } from './sdk';
import { run, SDK_COMMANDS, type CommandDeps } from './commands';

const DEFAULT_API_URL = process.env.BASEFYIO_API_URL || 'http://localhost:4000';

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

/** Hidden password prompt — echoes nothing while the user types. */
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const muteable = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk as Buffer, enc as BufferEncoding);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muteable, terminal: true });
    rl.question(prompt, (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

const USAGE = `basefyio — CLI for the basefyio platform

Usage:
  basefyio <command> [options]

Commands:
  doctor                              Check your local environment
  login --email <e> [--password <p>]  Sign in and save a token locally
  projects list                       List your projects
  projects create --name <n> --team <id> [--region <r>]
  projects get <id>                   Show one project
  sql execute <projectId> <query>     Run SQL against a project database
  storage buckets list <projectId>
  storage buckets create <projectId> <bucket> [--public]
  storage buckets delete <projectId> <bucket>
  help                                Show this help

Options:
  --url <url>       Platform API base URL (default ${DEFAULT_API_URL})
  -v, --version     Print the CLI version
  -h, --help        Show this help
`;

function sdkDeps(): CommandDeps {
  return {
    loadConfig: () => loadConfig(),
    saveConfig: (c) => saveConfig(c),
    makeClient,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    defaultApiUrl: DEFAULT_API_URL,
    readPassword,
  };
}

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
      if ((SDK_COMMANDS as readonly string[]).includes(cmd)) {
        return run(argv, sdkDeps());
      }
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
