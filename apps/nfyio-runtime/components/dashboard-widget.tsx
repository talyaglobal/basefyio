import { KPIWidget } from '../lib/types';

export function KPICard({ widget }: { widget: KPIWidget }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
      padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem',
    }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {widget.label}
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 700, color: '#1e293b' }}>
        {widget.value ?? '—'}
      </div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        {widget.aggregate === 'count' ? `${widget.table} count` : `${widget.aggregate}(${widget.field ?? 'value'})`}
      </div>
    </div>
  );
}

export function DashboardGrid({ widgets }: { widgets: KPIWidget[] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: '1rem',
      marginBottom: '2rem',
    }}>
      {widgets.map((w, i) => <KPICard key={i} widget={w} />)}
    </div>
  );
}
