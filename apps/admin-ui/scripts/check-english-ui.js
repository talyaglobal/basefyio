/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['app', 'components', 'lib'];
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const TURKISH_CHAR_REGEX = /[çğıöşüÇĞİÖŞÜ]/g;

function walk(dirPath, files = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(fullPath, files);
      continue;
    }
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(fullPath);
  }
  return files;
}

function getLineAndColumn(content, index) {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const lastNewLine = before.lastIndexOf('\n');
  const column = index - lastNewLine;
  return { line, column };
}

function main() {
  const violations = [];
  for (const relativeDir of TARGET_DIRS) {
    const dirPath = path.join(ROOT, relativeDir);
    if (!fs.existsSync(dirPath)) continue;
    const files = walk(dirPath);
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      let match;
      while ((match = TURKISH_CHAR_REGEX.exec(content)) !== null) {
        const { line, column } = getLineAndColumn(content, match.index);
        const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
        violations.push(`${relPath}:${line}:${column} contains "${match[0]}"`);
      }
      TURKISH_CHAR_REGEX.lastIndex = 0;
    }
  }

  if (violations.length > 0) {
    console.error('\n[check-english-ui] Turkish UI text detected. Build aborted.\n');
    for (const v of violations) console.error(`- ${v}`);
    console.error('\nPlease convert UI text to English before building.\n');
    process.exit(1);
  }

  console.log('[check-english-ui] Passed.');
}

main();
