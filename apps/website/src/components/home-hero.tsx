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
    <section className="relative min-h-[80vh] overflow-hidden">
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
      <div className="relative z-10 mx-auto max-w-6xl px-6">{children}</div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[5] h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}
