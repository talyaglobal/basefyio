'use client';

import { useState, useEffect } from 'react';
import { ApplicationModelEditor } from './application-model-editor';

interface Props {
  blueprintId: string;
}

export function BlueprintEditorPage({ blueprintId }: Props) {
  const [blueprint, setBlueprint] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generateStatus, setGenerateStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/v1/blueprints/${blueprintId}`, {
      headers: { 'Content-Type': 'application/json' },
    })
      .then((r) => r.json())
      .then((data) => {
        setBlueprint(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [blueprintId]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateStatus('queued');
    await fetch(`/v1/blueprints/${blueprintId}/generate`, { method: 'POST' });

    // Poll for status
    const poll = setInterval(async () => {
      const res = await fetch(`/v1/blueprints/${blueprintId}/status`);
      const data = await res.json();
      setGenerateStatus(data.status);
      if (['generated', 'error'].includes(data.status)) {
        clearInterval(poll);
        setGenerating(false);
        setBlueprint((b: any) => ({ ...b, status: data.status, projectId: data.projectId }));
      }
    }, 2000);
  };

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading blueprint…</div>;
  if (!blueprint) return <div style={{ padding: '2rem', color: '#ef4444' }}>Blueprint not found</div>;

  const dataModel = blueprint.dataModel as { tables: Array<{ name: string; displayName: string }> };
  const tables = dataModel?.tables ?? [];
  const currentModel = (blueprint as any).applicationModel ?? { name: 'My App', navigation: [], roles: [] };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}
      >
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Application Model</h1>
          <div style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.25rem' }}>
            Blueprint {blueprintId.slice(0, 8)} · status: <strong>{blueprint.status}</strong>
          </div>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating || blueprint.status === 'generated'}
          style={{
            padding: '0.6rem 1.25rem',
            background: blueprint.status === 'generated' ? '#10b981' : '#8b5cf6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontWeight: 600,
            cursor: generating ? 'not-allowed' : 'pointer',
            fontSize: '0.875rem',
          }}
        >
          {generating
            ? `${generateStatus ?? 'generating'}…`
            : blueprint.status === 'generated'
              ? 'Generated'
              : 'Generate App'}
        </button>
      </div>

      {blueprint.projectId && (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: 8,
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
            fontSize: '0.875rem',
          }}
        >
          App generated. Project ID: <strong>{blueprint.projectId}</strong>
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '1.5rem' }}>
        <ApplicationModelEditor
          blueprintId={blueprintId}
          initialModel={currentModel}
          tables={tables}
          onSaved={() => {}}
        />
      </div>
    </div>
  );
}
