'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Bot, Check, Copy } from 'lucide-react';

/**
 * Scopes that unlock at least one tool of the MCP server
 * (apps/platform-api/src/modules/mcp/mcp-tools.ts). Keep in step with that
 * catalogue: a token is only offered the tools its scopes cover.
 */
export const MCP_TOOL_SCOPES = [
  'team:read',
  'projects:read',
  'schema:read',
  'data:read',
  'data:write',
  'sql:read',
  'sql:run',
  'storage:read',
  'auth:read',
];

/** The read-only preset: every MCP read tool, and nothing that can change data. */
export const MCP_READ_ONLY_SCOPES = [
  'team:read',
  'projects:read',
  'schema:read',
  'data:read',
  'sql:read',
  'storage:read',
  'auth:read',
];

export const MCP_TOKEN_ENV = 'BASEFYIO_MCP_TOKEN';

export function mcpServerUrl(): string {
  const origin = (process.env.NEXT_PUBLIC_API_URL || 'https://api.basefyio.com').replace(/\/+$/, '');
  return `${origin}/api/mcp`;
}

export function holdsMcpScope(scopes: string[]): boolean {
  return scopes.some((s) => MCP_TOOL_SCOPES.includes(s));
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button size="sm" variant="outline" onClick={copy} className="h-7 gap-1 px-2 text-xs">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted/50 p-3 text-[11px] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/**
 * Client setup for the MCP server. The token itself never appears here: the
 * snippets read it from the BASEFYIO_MCP_TOKEN environment variable, so they
 * can be committed or shared safely.
 */
export function McpSetupBlocks() {
  const url = mcpServerUrl();
  const env = `${MCP_TOKEN_ENV}=<paste the token here>`;
  const claudeCode = `claude mcp add --transport http basefyio ${url} --header "Authorization: Bearer \${${MCP_TOKEN_ENV}}"`;
  const json = JSON.stringify(
    {
      mcpServers: {
        basefyio: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` },
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-primary" /> Connect an AI agent (MCP)
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Put the token in your project&apos;s environment as {MCP_TOKEN_ENV}. The agent gets the basefyio tools
          this token&apos;s permissions allow, and nothing more.
        </p>
      </div>
      <CopyBlock label="Environment (.env)" text={env} />
      <CopyBlock label="Claude Code" text={claudeCode} />
      <CopyBlock label="Clients configured with mcpServers (.mcp.json, url + headers)" text={json} />
    </div>
  );
}
