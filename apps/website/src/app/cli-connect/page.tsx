'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Terminal, CheckCircle, XCircle } from 'lucide-react';

function CliConnectContent() {
  const params = useSearchParams();
  const token = params?.get("token") ?? null;
  const portStr = params?.get("port") ?? null;
  const port = portStr ? parseInt(portStr, 10) : NaN;

  // Validate params — both are required and port must be a valid loopback port
  const isValid = token && !isNaN(port) && port >= 1024 && port <= 65535;

  function handleAllow() {
    window.location.href = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(token!)}`;
  }

  function handleDeny() {
    window.location.href = `http://127.0.0.1:${port}/callback?error=access_denied`;
  }

  if (!isValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <XCircle className="mx-auto h-12 w-12 text-destructive" style={{ color: '#ef4444' }} />
          <h1 className="text-xl font-semibold">Invalid request</h1>
          <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            This link is missing required parameters. Please run{' '}
            <code className="font-mono bg-muted px-1 rounded">basefyio login</code> again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div
        className="max-w-sm w-full rounded-2xl border shadow-sm p-8 space-y-6 text-center"
        style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}
      >
        {/* Icon */}
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: 'hsl(var(--secondary))' }}
        >
          <Terminal className="h-7 w-7" style={{ color: 'hsl(var(--primary))' }} />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Connect CLI to your account</h1>
          <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            The basefyio CLI is requesting access to your account. Allow it to manage
            your projects from the terminal.
          </p>
        </div>

        {/* What the CLI gets */}
        <ul
          className="text-left text-sm space-y-2 rounded-lg p-4"
          style={{ background: 'hsl(var(--muted))' }}
        >
          {[
            'Read and manage your projects',
            'Run database migrations',
            'Access secrets and environment variables',
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <button
            onClick={handleAllow}
            className="w-full rounded-lg py-2.5 px-4 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: 'hsl(var(--primary))' }}
          >
            Allow access
          </button>
          <button
            onClick={handleDeny}
            className="w-full rounded-lg py-2.5 px-4 text-sm font-medium transition-colors hover:bg-muted"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// useSearchParams requires a Suspense boundary in Next.js App Router
export default function CliConnectPage() {
  return (
    <Suspense>
      <CliConnectContent />
    </Suspense>
  );
}
