import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';

export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function error(message: string): void {
  console.log(chalk.red('✗'), message);
}

export function warning(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function log(message: string): void {
  console.log(message);
}

export function createSpinner(text: string): Ora {
  return ora(text).start();
}

export function printBox(content: string, options?: {
  title?: string;
  padding?: number;
  borderColor?: string;
}): void {
  console.log(
    boxen(content, {
      padding: options?.padding ?? 1,
      margin: 1,
      borderStyle: 'round',
      title: options?.title,
      titleAlignment: 'center',
      borderColor: options?.borderColor as any || 'cyan',
    })
  );
}

export function printHeader(text: string): void {
  console.log();
  console.log(chalk.bold.cyan(text));
  console.log(chalk.cyan('─'.repeat(text.length)));
}

export function printTable(headers: string[], rows: string[][]): void {
  const columnWidths = headers.map((header, i) => {
    const maxRowWidth = Math.max(...rows.map(row => (row[i] || '').length));
    return Math.max(header.length, maxRowWidth);
  });

  // Print headers
  const headerRow = headers.map((header, i) => 
    header.padEnd(columnWidths[i])
  ).join('  ');
  console.log(chalk.bold(headerRow));
  console.log(chalk.gray('─'.repeat(headerRow.length)));

  // Print rows
  rows.forEach(row => {
    const rowStr = row.map((cell, i) => 
      (cell || '').padEnd(columnWidths[i])
    ).join('  ');
    console.log(rowStr);
  });
}

export function printKeyValue(data: Record<string, string | number | boolean | null | undefined>): void {
  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));
  
  Object.entries(data).forEach(([key, value]) => {
    const paddedKey = chalk.bold(key.padEnd(maxKeyLength));
    const displayValue = value ?? chalk.gray('(not set)');
    console.log(`${paddedKey}  ${displayValue}`);
  });
}

export function printJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

export function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

export function printLogo(): void {
  const logo = `
${chalk.cyan('┌─────────────────────────────────────┐')}
${chalk.cyan('│')}  ${chalk.bold.cyan('K O L A Y B A S E')}                ${chalk.cyan('│')}
${chalk.cyan('│')}  ${chalk.gray('Backend-as-a-Service Platform')}    ${chalk.cyan('│')}
${chalk.cyan('└─────────────────────────────────────┘')}
  `;
  console.log(logo);
}
