"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { hslTripletToHex } from "@/lib/hsl-to-hex";

const Antigravity = dynamic(() => import("./antigravity").then((m) => m.Antigravity), {
  ssr: false,
  loading: () => null,
});

function usePrimaryParticleColor() {
  const { resolvedTheme } = useTheme();
  const [hex, setHex] = useState("#2563eb");

  useEffect(() => {
    const triplet = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary")
      .trim();
    if (triplet) setHex(hslTripletToHex(triplet));
  }, [resolvedTheme]);

  return hex;
}

export function HomeHero({ children }: { children: React.ReactNode }) {
  const particleColor = usePrimaryParticleColor();

  return (
    <section className="relative flex min-h-[80vh] flex-col overflow-hidden">
      <div className="absolute inset-0 z-0 min-h-[80vh] w-full">
        <Antigravity
          count={320}
          color={particleColor}
          autoAnimate
          magnetRadius={12}
          ringRadius={8}
          waveSpeed={0.3}
          waveAmplitude={1.2}
          lerpSpeed={0.08}
          particleShape="capsule"
          className="min-h-[80vh] w-full"
          style={{ minHeight: "80vh" }}
        />
      </div>
      <div
        className="noise-overlay z-[1] opacity-70"
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-b from-background/50 via-transparent to-background" />
      {/* Outer: full hero height; pt-16 clears fixed header (h-16). Inner: flex-1 + justify-center = vertical center */}
      <div className="relative z-10 flex min-h-[80vh] w-full flex-col px-6 pt-16 md:pb-4">
        <div className="flex flex-1 flex-col items-center justify-center py-8 md:py-12">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[5] h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}
