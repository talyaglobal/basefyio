import { Table } from '../lib/types';

interface Props {
  table: Table;
  rows: Record<string, unknown>[];
}

export function ListTable({ table, rows }: Props) {
  const columns = table.fields.filter((f) => !f.primaryKey).slice(0, 6);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
            {columns.map((col) => (
              <th key={col.name} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>
                {col.description || col.name}
              </th>
            ))}
            <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
                No records yet
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                {columns.map((col) => (
                  <td key={col.name} style={{ padding: '0.75rem 1rem', color: '#1e293b' }}>
                    {String(row[col.name] ?? '')}
                  </td>
                ))}
                <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                  <a href={`/${table.name}/${row['id']}`} style={{ color: '#3b82f6', textDecoration: 'none', fontSize: '0.8rem' }}>
                    View
                  </a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
