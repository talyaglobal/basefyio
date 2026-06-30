'use client';

import React from 'react';

/** Inline: `code`, **bold**, [text](url). (Content is our own, root-only.) */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyPrefix}-${i++}`;
    if (tok.startsWith('`')) {
      nodes.push(<code key={k} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{mm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const cells = (row: string) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Items/rows marked done (lead with ✅) render green. */
const done = (text: string) =>
  text.trimStart().startsWith('✅') ? 'text-emerald-600 dark:text-emerald-400 font-medium' : '';

export function MarkdownView({ md }: { md: string }) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const K = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={K()} className="my-3 overflow-x-auto rounded-lg bg-muted p-3 text-xs"><code>{buf.join('\n')}</code></pre>);
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(<hr key={K()} className="my-5 border-border" />); i++; continue; }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const cls = ['mt-6 mb-3 text-2xl font-bold', 'mt-6 mb-2 text-xl font-bold', 'mt-5 mb-2 text-lg font-semibold', 'mt-4 mb-1 text-base font-semibold'][lvl - 1];
      const content = inline(h[2], K());
      out.push(lvl === 1 ? <h1 key={K()} className={cls}>{content}</h1> : lvl === 2 ? <h2 key={K()} className={cls}>{content}</h2> : lvl === 3 ? <h3 key={K()} className={cls}>{content}</h3> : <h4 key={K()} className={cls}>{content}</h4>);
      i++;
      continue;
    }

    // Table (header row | --- | rows)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={K()} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr className="border-b bg-muted/40">{header.map((c, ci) => <th key={ci} className="px-3 py-2 text-left font-semibold">{inline(c, K())}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri} className={`border-b last:border-0${r.some((c) => c.includes('✅')) ? ' bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : ''}`}>{r.map((c, ci) => <td key={ci} className="px-3 py-2 align-top">{inline(c, K())}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={K()} className="my-3 border-l-2 border-primary/50 pl-3 text-sm text-muted-foreground">{buf.map((b, bi) => <p key={bi}>{inline(b, K())}</p>)}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(<ul key={K()} className="my-2 ml-5 list-disc space-y-1 text-sm">{items.map((it, ii) => <li key={ii} className={done(it)}>{inline(it, K())}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      out.push(<ol key={K()} className="my-2 ml-5 list-decimal space-y-1 text-sm">{items.map((it, ii) => <li key={ii} className={done(it)}>{inline(it, K())}</li>)}</ol>);
      continue;
    }

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Paragraph (gather consecutive plain lines)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|>\s|\d+\.\s|```)/.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i].trim()) && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push(<p key={K()} className="my-2 text-sm leading-relaxed">{inline(buf.join(' '), K())}</p>);
    else i++;
  }

  return <div className="max-w-none">{out}</div>;
}
