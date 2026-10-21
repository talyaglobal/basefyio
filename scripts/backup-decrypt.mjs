#!/usr/bin/env node
// Decrypt a backup artifact that basefyio encrypted (format "BFENC1").
//
// Usage:
//   BACKUP_ENC_KEY=<base64 or 64 hex chars> node scripts/backup-decrypt.mjs <input.enc> <output>
//
// The platform encrypts off-site copies (and, with BACKUP_ENCRYPT_LOCAL=true,
// its nightly archives) with AES-256-GCM under BACKUP_ENC_KEY. This script is
// deliberately dependency-free so it runs anywhere Node does — on the host, on
// a laptop, in a recovery container — without the platform being up.
//
// Layout of an encrypted object:
//   0..5    "BFENC1"            6..6   version 0x01
//   7..10   key fingerprint     11..22 IV (12 bytes)
//   23..n   ciphertext (same length as the plaintext)
//   last 16 GCM authentication tag
// The 23-byte header is authenticated together with the body.
//
// Exit codes: 0 decrypted; 1 bad usage, wrong key, altered or truncated file.
// The output is written to <output>.partial and renamed only after the
// authentication tag has verified, so a half-written file never passes for a
// good one.

import { createDecipheriv, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('BFENC1', 'ascii');
const VERSION = 0x01;
const HEADER = 23;
const TAG = 16;

function fail(message) {
  console.error(`backup-decrypt: ${message}`);
  process.exit(1);
}

function parseKey(raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const b = Buffer.from(value, 'base64');
  return b.length === 32 ? b : null;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  fail('usage: BACKUP_ENC_KEY=<key> node scripts/backup-decrypt.mjs <input.enc> <output>');
}
const key = parseKey(process.env.BACKUP_ENC_KEY);
if (!key) fail('BACKUP_ENC_KEY must be 32 bytes as base64 or 64 hex characters');

const fd = await open(input, 'r');
let size;
let header;
let tag;
try {
  size = (await fd.stat()).size;
  if (size < HEADER + TAG) fail('file is too short to be an encrypted backup (truncated?)');
  header = Buffer.alloc(HEADER);
  await fd.read(header, 0, HEADER, 0);
  tag = Buffer.alloc(TAG);
  await fd.read(tag, 0, TAG, size - TAG);
} finally {
  await fd.close();
}

if (!header.subarray(0, 6).equals(MAGIC)) fail('not a basefyio encrypted backup (missing BFENC1 header)');
if (header[6] !== VERSION) fail(`unsupported encrypted backup version ${header[6]}`);
const fingerprint = createHash('sha256').update(key).digest().subarray(0, 4);
if (!header.subarray(7, 11).equals(fingerprint)) {
  fail('BACKUP_ENC_KEY does not match the key this backup was encrypted with');
}

const iv = header.subarray(11, HEADER);
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAAD(header);
decipher.setAuthTag(tag);

const partial = `${output}.partial`;
try {
  const bodyEnd = size - TAG - 1; // inclusive end for createReadStream
  const body =
    bodyEnd >= HEADER
      ? createReadStream(input, { start: HEADER, end: bodyEnd })
      : createReadStream(input, { start: HEADER, end: HEADER - 1 }); // empty plaintext
  await pipeline(body, decipher, createWriteStream(partial));
  await rename(partial, output);
  console.log(`decrypted ${size - HEADER - TAG} bytes → ${output}`);
} catch (err) {
  await unlink(partial).catch(() => undefined);
  fail(`authentication failed — the file was altered, truncated, or encrypted with another key (${err.message})`);
}
