import { NavSidebar } from '../components/nav-sidebar';
import { demoBuildPackage } from '../lib/build-package';

export const metadata = { title: 'Nfyio Runtime' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const bp = demoBuildPackage();
  // Map nav items: 'dashboard' table → /dashboard, others → /[table]
  const navItems = bp.applicationModel.navigation.map((item) => ({
    ...item,
    href: item.table === 'dashboard' ? '/dashboard' : `/${item.table}`,
  }));

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh' }}>
        <NavSidebar items={navItems} appName={bp.applicationModel.name} />
        <main style={{ flex: 1, padding: '2rem', background: '#f8fafc' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
