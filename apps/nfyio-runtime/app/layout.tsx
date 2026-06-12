import { NavSidebar } from '../components/nav-sidebar';
import { demoBuildPackage } from '../lib/build-package';

export const metadata = { title: 'Nfyio Runtime' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const bp = demoBuildPackage();
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh' }}>
        <NavSidebar items={bp.applicationModel.navigation} appName={bp.applicationModel.name} />
        <main style={{ flex: 1, padding: '2rem', background: '#f8fafc' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
