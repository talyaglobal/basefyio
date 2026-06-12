import Link from 'next/link';
import { NavItem } from '../lib/types';

export function NavSidebar({ items, appName }: { items: Array<NavItem & { href?: string }>; appName: string }) {
  return (
    <nav style={{ width: 220, background: '#1e293b', color: '#f1f5f9', minHeight: '100vh', padding: '1.5rem 1rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '1.5rem', color: '#f8fafc' }}>
        {appName}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((item) => (
          <li key={item.table} style={{ marginBottom: '0.25rem' }}>
            <Link
              href={item.href ?? `/${item.table}`}
              style={{ display: 'block', padding: '0.5rem 0.75rem', borderRadius: 6, color: '#cbd5e1', textDecoration: 'none' }}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
