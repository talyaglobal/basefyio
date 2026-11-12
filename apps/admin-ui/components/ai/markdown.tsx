'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * A small Markdown renderer for assistant replies.
 *
 * It builds React elements — never HTML strings — so nothing the model writes
 * can inject markup. Covered: headings, paragraphs, bold/italic/inline code,
 * links (http/https only), ordered and nested lists, block quotes, rules,
 * GitHub tables and fenced code. A fence that is still open while a reply
 * streams renders as code, so text does not jump when the fence closes.
 */

export interface MarkdownProps {
  text: string;
  /** Renders a fenced code block; `lang` is lower-case ('' when none). */
  renderCode: (code: string, lang: string, key: string, closed: boolean) => React.ReactNode;
  className?: string;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | { type: 'hr' }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { type: 'list'; items: ListItem[]; ordered: boolean; start: number };

interface ListItem {
  text: string;
  children: Block[];
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next))
  );
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker[0].repeat(marker.length)) && /^\s*(```+|~~~+)\s*$/.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang: fence[2].toLowerCase(), code: body.join('\n'), closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const start = i;
      const baseIndent = (LIST_ITEM.exec(line) as RegExpExecArray)[1].length;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
            i++;
            continue;
          }
          break;
        }
        const m = LIST_ITEM.exec(l);
        if (m && m[1].length < baseIndent) break;
        if (!m && !/^\s+\S/.test(l) && i > start) {
          // An unindented line that is not an item: a lazy continuation only
          // when it is not the start of another block.
          if (isBlockStart(l, lines[i + 1])) break;
        }
        if (FENCE.test(l) && !/^\s{2,}/.test(l)) break;
        i++;
      }
      blocks.push(parseList(lines.slice(start, i)));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
      if (!para.length && isBlockStart(lines[i], lines[i + 1])) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    else i++;
  }
  return blocks;
}

function parseList(lines: string[]): Block {
  const first = LIST_ITEM.exec(lines[0]) as RegExpExecArray;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let current: { text: string[]; rest: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const children = current.rest.length ? parseBlocks(dedent(current.rest)) : [];
    items.push({ text: current.text.join('\n'), children });
  };

  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    if (m && m[1].length <= baseIndent + 1) {
      flush();
      current = { text: [m[3]], rest: [] };
    } else if (current) {
      if (!current.rest.length && !m && line.trim() && !/^\s{2,}(```|[-*+] |\d+[.)] )/.test(line)) {
        current.text.push(line.trim());
      } else {
        current.rest.push(line);
      }
    }
  }
  flush();
  return { type: 'list', items, ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1 };
}

function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => (/^\s*/.exec(l) as RegExpExecArray)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, (/^\s*/.exec(l) as RegExpExecArray)[0].length))).join('\n');
}

/* ───────────────────────────── inline ───────────────────────────── */

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|~~([^~\n]+)~~|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'")\]])/g;

export function renderInline(text: string, keyPrefix = 'i'): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const parts = s.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) out.push(<br key={`${keyPrefix}-br-${n++}`} />);
      if (p) out.push(p);
    });
  };
  // A fresh regex per call: renderInline recurses into bold/italic/link text,
  // and a shared /g regex would have its position reset by the inner call.
  const re = new RegExp(INLINE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">
          {m[2].trim()}
        </code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[3] ?? m[4], key)}</strong>);
    } else if (m[5] !== undefined) {
      out.push(
        <a key={key} href={m[6]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
          {renderInline(m[5], key)}
        </a>,
      );
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(<em key={key}>{renderInline(m[7] ?? m[8], key)}</em>);
    } else if (m[9] !== undefined) {
      out.push(<del key={key}>{renderInline(m[9], key)}</del>);
    } else if (m[10] !== undefined) {
      out.push(
        <a key={key} href={m[10]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 break-all">
          {m[10]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

/* ───────────────────────────── render ───────────────────────────── */

function renderBlocks(blocks: Block[], props: MarkdownProps, prefix: string): React.ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${prefix}-${idx}`;
    switch (b.type) {
      case 'heading': {
        const sizes = ['text-base', 'text-[15px]', 'text-sm', 'text-[13px]', 'text-xs', 'text-xs'];
        return React.createElement(
          `h${Math.min(b.level + 1, 6)}`,
          { key, className: cn('font-semibold leading-snug mt-3 first:mt-0', sizes[b.level - 1]) },
          renderInline(b.text, key),
        );
      }
      case 'paragraph':
        return (
          <p key={key} className="leading-relaxed break-words">
            {renderInline(b.text, key)}
          </p>
        );
      case 'hr':
        return <hr key={key} className="my-2 border-border" />;
      case 'quote':
        return (
          <blockquote key={key} className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
            {renderBlocks(parseBlocks(b.text), props, key)}
          </blockquote>
        );
      case 'code':
        return <React.Fragment key={key}>{props.renderCode(b.code, b.lang, key, b.closed)}</React.Fragment>;
      case 'table':
        return (
          <div key={key} className="w-full overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-muted/60">
                <tr>
                  {b.header.map((h, c) => (
                    <th key={c} className="px-2 py-1.5 font-semibold whitespace-nowrap" style={{ textAlign: b.align[c] ?? undefined }}>
                      {renderInline(h, `${key}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {b.header.map((_, c) => (
                      <td key={c} className="px-2 py-1 align-top" style={{ textAlign: b.align[c] ?? undefined }}>
                        {renderInline(row[c] ?? '', `${key}-${r}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={key}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={cn('space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}
          >
            {b.items.map((item, n) => (
              <li key={n} className="leading-relaxed break-words">
                {renderInline(item.text, `${key}-${n}`)}
                {item.children.length > 0 && <div className="mt-1 space-y-1.5">{renderBlocks(item.children, props, `${key}-${n}`)}</div>}
              </li>
            ))}
          </Tag>
        );
      }
    }
  });
}

export function Markdown(props: MarkdownProps) {
  const blocks = React.useMemo(() => parseBlocks(props.text), [props.text]);
  return <div className={cn('space-y-2 text-xs text-foreground', props.className)}>{renderBlocks(blocks, props, 'md')}</div>;
}
