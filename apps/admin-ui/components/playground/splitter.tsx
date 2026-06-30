'use client';

import { useRef, useState } from 'react';

/** Horizontal split with a draggable divider. Pure pointer-events, no deps. */
export function Splitter({
  left,
  right,
  initial = 55,
  min = 25,
  max = 80,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  initial?: number;
  min?: number;
  max?: number;
}) {
  const [pct, setPct] = useState(initial);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div style={{ width: `${pct}%` }} className="flex min-w-0 flex-col">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current || !containerRef.current) return;
          const rect = containerRef.current.getBoundingClientRect();
          const next = ((e.clientX - rect.left) / rect.width) * 100;
          setPct(Math.min(max, Math.max(min, next)));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* capture may already be released */
          }
        }}
        className="w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
      />
      <div className="flex min-w-0 flex-1 flex-col">{right}</div>
    </div>
  );
}
