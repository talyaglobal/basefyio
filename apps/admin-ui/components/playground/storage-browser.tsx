'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, FileText, HardDrive, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listObjectsRequest, downloadObjectRequest } from '@/lib/playground/rest';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RestRequestView } from './rest-explorer';

interface DemoObject {
  name: string;
  size: number;
  contentType: string;
  lastModified: string;
  content: string;
}

interface DemoBucket {
  name: string;
  public: boolean;
  objects: DemoObject[];
}

// Read-only demo storage. Objects are synthesized client-side so "Download"
// produces a real file without any backend. Upload/Delete are intentionally
// disabled in the public sandbox.
const DEMO_BUCKETS: DemoBucket[] = [
  {
    name: 'avatars',
    public: true,
    objects: [
      { name: 'ada.txt', size: 38, contentType: 'text/plain', lastModified: '2025-11-02', content: 'Avatar placeholder for Ada Lovelace.' },
      { name: 'grace.txt', size: 39, contentType: 'text/plain', lastModified: '2025-11-04', content: 'Avatar placeholder for Grace Hopper.' },
    ],
  },
  {
    name: 'documents',
    public: false,
    objects: [
      { name: 'welcome.md', size: 64, contentType: 'text/markdown', lastModified: '2025-12-01', content: '# Welcome to basefyio\n\nThis is a demo document from the sandbox.' },
      { name: 'report.json', size: 52, contentType: 'application/json', lastModified: '2025-12-10', content: '{\n  "rows": 15,\n  "generatedBy": "basefyio playground"\n}' },
    ],
  },
  {
    name: 'exports',
    public: false,
    objects: [
      { name: 'orders.csv', size: 71, contentType: 'text/csv', lastModified: '2026-01-08', content: 'id,user_id,total,status\n1,1,129.00,shipped\n2,1,99.00,shipped' },
    ],
  },
];

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function StorageBrowser() {
  const [selected, setSelected] = useState(DEMO_BUCKETS[0].name);
  const bucket = DEMO_BUCKETS.find((b) => b.name === selected) ?? DEMO_BUCKETS[0];
  const [activeObject, setActiveObject] = useState<string | null>(null);

  function download(obj: DemoObject) {
    const blob = new Blob([obj.content], { type: obj.contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = obj.name;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${obj.name}`);
  }

  const restRequest = activeObject
    ? downloadObjectRequest(bucket.name, activeObject)
    : listObjectsRequest(bucket.name);

  return (
    <div className="flex h-full min-h-0">
      {/* Bucket list */}
      <div className="flex w-48 shrink-0 flex-col border-r">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Buckets</div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {DEMO_BUCKETS.map((b) => (
            <button
              key={b.name}
              type="button"
              onClick={() => {
                setSelected(b.name);
                setActiveObject(null);
              }}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm',
                selected === b.name
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60',
              )}
            >
              <HardDrive className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{b.name}</span>
              {b.public ? null : <Lock className="ml-auto h-3 w-3 shrink-0 opacity-60" />}
            </button>
          ))}
        </div>
      </div>

      {/* Objects */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{bucket.name}</span>
            <Badge variant={bucket.public ? 'secondary' : 'outline'} className="text-xs">
              {bucket.public ? 'Public' : 'Private'}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7" disabled title="Disabled in the public sandbox">
              Upload
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1">
          <div className="min-h-0 overflow-auto border-b p-3 lg:border-b-0 lg:border-r">
            <div className="divide-y rounded-md border">
              {bucket.objects.map((obj) => (
                <button
                  key={obj.name}
                  type="button"
                  onClick={() => setActiveObject(obj.name)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left',
                    activeObject === obj.name ? 'bg-accent/50' : 'hover:bg-muted/40',
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{obj.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(obj.size)} · {obj.contentType} · {obj.lastModified}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        download(obj);
                      }}
                      title="Download"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 px-1 text-xs text-muted-foreground">
              Download is enabled. Upload and delete are disabled in the public sandbox.
            </p>
          </div>

          {/* Equivalent REST for the current view */}
          <div className="min-h-0 overflow-auto p-3">
            <RestRequestView request={restRequest} />
          </div>
        </div>
      </div>
    </div>
  );
}
