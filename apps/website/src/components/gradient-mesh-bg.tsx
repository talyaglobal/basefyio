"use client";

import { cn } from "@/lib/utils";

export function GradientMeshBg({ className }: { className?: string }) {
  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)}>
      {/* Primary blob — large, slow drift */}
      <div
        className="gradient-blob absolute rounded-full opacity-[0.15] dark:opacity-[0.10]"
        style={{
          width: "70%",
          height: "70%",
          top: "-10%",
          left: "-10%",
          background:
            "radial-gradient(circle, hsl(var(--primary)) 0%, transparent 70%)",
          filter: "blur(80px)",
          animation: "meshFloat1 20s ease-in-out infinite",
        }}
      />

      {/* Secondary blob — medium, offset drift */}
      <div
        className="gradient-blob absolute rounded-full opacity-[0.10] dark:opacity-[0.08]"
        style={{
          width: "60%",
          height: "60%",
          bottom: "-5%",
          right: "-15%",
          background:
            "radial-gradient(circle, hsl(214 89% 60%) 0%, transparent 70%)",
          filter: "blur(70px)",
          animation: "meshFloat2 25s ease-in-out infinite",
        }}
      />

      {/* Accent blob — smaller, faster */}
      <div
        className="gradient-blob absolute rounded-full opacity-[0.08] dark:opacity-[0.06]"
        style={{
          width: "40%",
          height: "40%",
          top: "30%",
          left: "30%",
          background:
            "radial-gradient(circle, hsl(214 70% 50%) 0%, transparent 70%)",
          filter: "blur(60px)",
          animation: "meshFloat3 18s ease-in-out infinite",
        }}
      />

      {/* Subtle grid overlay for tech aesthetic */}
      <div
        className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary)) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />
    </div>
  );
}
