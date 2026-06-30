'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GLOBAL_ERROR]', error.message, error.stack, error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'Inter, sans-serif', background: '#0a0a0a', color: '#e5e5e5' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h2>
          <pre style={{ fontSize: 12, background: '#1a1a1a', padding: 16, borderRadius: 8, maxWidth: 600, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {error.message}
          </pre>
          <button
            onClick={reset}
            style={{ padding: '8px 20px', borderRadius: 8, background: '#3b82f6', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
