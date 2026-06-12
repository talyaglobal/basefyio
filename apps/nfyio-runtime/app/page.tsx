import { demoBuildPackage } from '../lib/build-package';
import Link from 'next/link';

export default function HomePage() {
  const bp = demoBuildPackage();
  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        {bp.applicationModel.name}
      </h1>
      <p style={{ color: '#64748b', marginBottom: '1.5rem' }}>
        {bp.dataModel.tables.length} tables · generated {new Date(bp.generatedAt).toLocaleDateString()}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem' }}>
        {bp.applicationModel.navigation.map((item) => (
          <Link
            key={item.table}
            href={`/${item.table}`}
            style={{
              display: 'block', padding: '1.25rem', background: '#fff',
              border: '1px solid #e2e8f0', borderRadius: 8, textDecoration: 'none',
              color: '#1e293b', fontWeight: 600,
            }}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
