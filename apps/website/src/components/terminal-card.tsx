"use client";

import { useEffect, useRef, useState } from "react";

const SERVICES = [
  { svc: "database", status: "cluster ready" },
  { svc: "REST API", status: "REST API live" },
  { svc: "storage", status: "buckets + CDN" },
  { svc: "auth", status: "auth service ready" },
  { svc: "ai-assistant", status: "context loaded" },
];

export function TerminalCard() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [showLive, setShowLive] = useState(false);
  const [timer, setTimer] = useState(0);
  const started = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (started.current) return;

    const el = ref.current;
    if (!el) return;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (prefersReduced) {
      setVisibleLines(SERVICES.length);
      setShowLive(true);
      setTimer(38);
      started.current = true;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !started.current) {
          started.current = true;
          observer.disconnect();
          runAnimation();
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function runAnimation() {
    SERVICES.forEach((_, i) => {
      setTimeout(() => setVisibleLines(i + 1), 500 + i * 300);
    });

    const afterLines = 500 + SERVICES.length * 300 + 300;
    setTimeout(() => {
      setShowLive(true);
      let t = 0;
      const iv = setInterval(() => {
        t += 2;
        if (t >= 38) {
          t = 38;
          clearInterval(iv);
        }
        setTimer(t);
      }, 30);
    }, afterLines);
  }

  return (
    <div ref={ref} className="terminal-card">
      <div className="term-bar">
        <span className="term-title">basefyio &middot; provision</span>
        <div className="term-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="term-body">
        <div className="term-cmd">
          <span className="term-prompt">$</span> basefyio init my-app
        </div>
        {SERVICES.map((s, i) => (
          <div
            key={s.svc}
            className={`term-line ${i < visibleLines ? "visible" : ""}`}
          >
            <span className="term-chk">&#10003;</span>
            <span className="term-svc">{s.svc}</span>
            <span className="term-st">{s.status}</span>
          </div>
        ))}
        <div className={`term-live ${showLive ? "visible" : ""}`}>
          <span className="term-glow">&#x1F7E2;</span>
          <span>connected &middot; my-app.basefyio.dev</span>
          <span className="term-timer">
            (00:{String(timer).padStart(2, "0")})
          </span>
        </div>
      </div>
    </div>
  );
}
