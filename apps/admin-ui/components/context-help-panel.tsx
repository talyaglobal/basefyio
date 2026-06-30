'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { CircleHelp, X, ExternalLink, Lightbulb, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getHelpForPath } from '@/lib/context-help-data';
import type { HelpContent } from '@/lib/context-help-data';

const STORAGE_KEY = 'basefyio_context_help_open';
const DOCS_BASE = process.env.NEXT_PUBLIC_DOCS_URL || 'https://basefyio.com';

function readStored(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function ContextHelpPanel() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(readStored);
  const help = getHelpForPath(pathname);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  // Allow external components to open the panel via a custom DOM event.
  useEffect(() => {
    const handler = () => setIsOpen(true);
    window.addEventListener('basefyio-open-help', handler);
    return () => window.removeEventListener('basefyio-open-help', handler);
  }, []);

  if (!help) return null;

  // Toggle button (when closed)
  if (!isOpen) {
    return null;
  }

  // Open panel
  return (
    <aside className="hidden lg:flex w-72 shrink-0 border-l bg-card flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{help.pageTitle}</span>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Description */}
        <p className="text-sm text-muted-foreground leading-relaxed">
          {help.description}
        </p>

        {/* Quick Start Steps */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Quick Start
          </h4>
          <ol className="space-y-2">
            {help.steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold">
                  {i + 1}
                </span>
                <span className="text-foreground leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Tips */}
        {help.tips && help.tips.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Tips
            </h4>
            <ul className="space-y-2">
              {help.tips.map((tip, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <Lightbulb className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                  <span className="text-muted-foreground leading-relaxed">{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer — docs link */}
      <div className="border-t px-4 py-3 shrink-0">
        <a
          href={`${DOCS_BASE}${help.docPath}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          <BookOpen className="h-4 w-4" />
          Read full documentation
          <ExternalLink className="ml-auto h-3 w-3 opacity-60" />
        </a>
      </div>
    </aside>
  );
}
