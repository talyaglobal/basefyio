'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStrings } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Copy, Database, Key, Link2, Shield } from 'lucide-react';

interface ConnectionStringsViewProps {
  projectId: string;
}

function CopyBlock({ label, value, icon: Icon, mono = true }: {
  label: string;
  value: string;
  icon?: React.ElementType;
  mono?: boolean;
}) {
  function copy() {
    navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {label}
        </div>
        <Button variant="ghost" size="sm" onClick={copy} className="h-7 px-2 text-xs">
          <Copy className="mr-1.5 h-3 w-3" />
          Copy
        </Button>
      </div>
      <div className="px-4 py-3">
        <code className={`text-sm break-all ${mono ? 'font-mono' : ''}`}>{value}</code>
      </div>
    </div>
  );
}

export function ConnectionStringsView({ projectId }: ConnectionStringsViewProps) {
  const [conn, setConn] = useState<ConnectionStrings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.projects
      .connect(projectId)
      .then(setConn)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || !conn) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Connection</h1>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Database className="h-5 w-5" />
          Database
        </h2>
        <CopyBlock label="Connection URI" value={conn.uri} icon={Link2} />
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyBlock label="Host" value={conn.host} icon={Database} />
          <CopyBlock label="Port" value={String(conn.port)} icon={Database} />
          <CopyBlock label="Database" value={conn.database} icon={Database} />
          <CopyBlock label="User" value={conn.user} icon={Database} />
          <CopyBlock label="Password" value={conn.password} icon={Key} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Shield className="h-5 w-5" />
          Authentication
        </h2>
        <CopyBlock label="Keycloak Realm" value={conn.keycloakRealm} icon={Shield} />
        <CopyBlock label="Keycloak URL" value={conn.keycloakUrl} icon={Link2} />
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Key className="h-5 w-5" />
          API Keys
        </h2>
        <CopyBlock label="Anon Key (public)" value={conn.anonKey} icon={Key} />
        <CopyBlock label="Service Key (secret)" value={conn.serviceKey} icon={Key} />
      </section>
    </div>
  );
}
