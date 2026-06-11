"use client";

import { useState } from "react";

const STEPS = [
  {
    num: "01",
    label: "Name your project",
    pill: null,
    mock: (
      <>
        <div className="mock-head">basefyio &middot; new project</div>
        <div className="mock-row">
          <span className="mk">name</span>
          <span className="mv">my-app<span className="code-cursor-blink" /></span>
        </div>
        <div className="mock-row">
          <span className="mk">region</span>
          <span className="mv">fra1 &middot; Frankfurt</span>
        </div>
        <div className="mock-row">
          <span className="mk">runtime</span>
          <span className="mv">kubernetes</span>
        </div>
      </>
    ),
  },
  {
    num: "02",
    label: "Database",
    pill: "database",
    mock: (
      <>
        <div className="mock-head">database &middot; cluster</div>
        <div className="mock-row">
          <span className="mk">engine</span>
          <span className="mv">Database engine</span>
        </div>
        <div className="mock-row">
          <span className="mk">isolation</span>
          <span className="mv">per-project</span>
        </div>
        <div className="mock-row">
          <span className="mk">backups</span>
          <span className="mt">PITR &#10003;</span>
        </div>
        <div className="mock-row">
          <span className="mk">encryption</span>
          <span className="mt">at rest &#10003;</span>
        </div>
      </>
    ),
  },
  {
    num: "03",
    label: "REST API",
    pill: "REST API",
    mock: (
      <>
        <div className="mock-head">REST API &middot; endpoints</div>
        <div className="mock-row">
          <span className="mk">GET</span>
          <span className="mv">/users</span>
        </div>
        <div className="mock-row">
          <span className="mk">GET</span>
          <span className="mv">/products?select=*</span>
        </div>
        <div className="mock-row">
          <span className="mk">POST</span>
          <span className="mv">/rpc/search</span>
        </div>
        <div className="mock-row">
          <span className="mk">auth</span>
          <span className="mt">row-level &#10003;</span>
        </div>
      </>
    ),
  },
  {
    num: "04",
    label: "Authentication",
    pill: "auth",
    mock: (
      <>
        <div className="mock-head">auth &middot; realm</div>
        <div className="mock-row">
          <span className="mk">email/pass</span>
          <span className="mt">enabled &#10003;</span>
        </div>
        <div className="mock-row">
          <span className="mk">Google</span>
          <span className="mt">enabled &#10003;</span>
        </div>
        <div className="mock-row">
          <span className="mk">GitHub</span>
          <span className="mt">enabled &#10003;</span>
        </div>
        <div className="mock-row">
          <span className="mk">JWT</span>
          <span className="mv">auto-mapped</span>
        </div>
      </>
    ),
  },
  {
    num: "05",
    label: "Storage",
    pill: "S3",
    mock: (
      <>
        <div className="mock-head">storage &middot; buckets</div>
        <div className="mock-row">
          <span className="mk">assets</span>
          <span className="mv">s3-compatible</span>
        </div>
        <div className="mock-row">
          <span className="mk">uploads</span>
          <span className="mv">resumable</span>
        </div>
        <div className="mock-row">
          <span className="mk">cdn</span>
          <span className="mt">edge &#10003;</span>
        </div>
      </>
    ),
  },
  {
    num: "06",
    label: "Connected",
    pill: null,
    mock: (
      <>
        <div className="mock-head">project ready</div>
        <div className="mock-golive">
          <span
            className="inline-flex items-center gap-2 rounded px-2 py-0.5 text-xs"
            style={{
              background: "hsl(var(--primary) / 0.12)",
              color: "hsl(var(--primary))",
              border: "1px solid hsl(var(--primary) / 0.3)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            &#x25CF; connected
          </span>
          <span className="golive-big">Ready in 38s</span>
          <span className="golive-url">&#x1F7E2; my-app.basefyio.dev &#x2197;</span>
        </div>
      </>
    ),
  },
];

export function HowItWorks() {
  const [active, setActive] = useState(0);

  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-12">
      <div className="lg:col-span-5">
        <span className="section-label">How it works</span>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          From init to connected &mdash; in one project.
        </h2>
        <p className="mt-5 max-w-sm text-muted-foreground">
          basefyio provisions every layer in a single run. You write one
          connection string.
        </p>
        <div className="mt-10">
          {STEPS.map((step, i) => (
            <div
              key={step.num}
              className={`step-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <span className="step-num">{step.num}</span>
              <span className="step-text flex-1">{step.label}</span>
              {step.pill && (
                <span className="feat-pill-tag">{step.pill}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-7">
        <div className="sticky top-28">
          <div className="mock-card">
            {STEPS[active]?.mock}
          </div>
        </div>
      </div>
    </div>
  );
}
