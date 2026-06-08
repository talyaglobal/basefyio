"use client";

import { GradientMeshBg } from "./gradient-mesh-bg";

export function HomeHero({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative flex min-h-[90vh] flex-col overflow-hidden">
      <div className="absolute inset-0 z-0 min-h-[90vh] w-full">
        <GradientMeshBg className="min-h-[90vh] w-full" />
      </div>
      <div className="noise-overlay z-[1] opacity-70" aria-hidden />
      <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-b from-background/50 via-transparent to-background" />
      <div className="relative z-10 flex min-h-[90vh] w-full flex-col px-6 pb-0 pt-24">
        <div className="flex flex-1 flex-col items-center justify-center py-6 md:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[5] h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}
