'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  Table2,
  FileJson,
  Lightbulb,
  RotateCcw,
} from 'lucide-react';

/**
 * AI Database Advisor — a pre-creation guided wizard that asks the user about
 * their business need in plain language (never "SQL vs NoSQL") and recommends
 * the data model. basefyio provisions two models — Relational and Document —
 * so analytics / files / graph leanings are honestly mapped onto the closest
 * provisionable option with tailored guidance.
 *
 * The engine is deterministic (instant, offline, free); the "AI" is the UX.
 */

export type AdvisorModel = 'RELATIONAL' | 'NOSQL';

interface AdvisorRecommendation {
  model: AdvisorModel;
  /** Business-language headline, no DB jargon. */
  title: string;
  reasoning: string[];
  templateName: string;
  /** Tables (relational) or collections (document). */
  entities: string[];
  alternative: string;
  scalability: string;
  /** Extra note, e.g. file-heavy → Storage. */
  note?: string;
}

type Lean = 'relational' | 'document';

interface Option {
  label: string;
  /** Weight toward each provisionable model. */
  lean: Partial<Record<Lean, number>>;
  /** Soft signals used only for tailored reasoning / notes. */
  signal?: 'analytics' | 'files' | 'graph' | 'transactions' | 'search';
  /** For Q1 only — which starter template this maps to. */
  template?: string;
}

interface Question {
  id: string;
  prompt: string;
  options: Option[];
}

const QUESTIONS: Question[] = [
  {
    id: 'building',
    prompt: 'What are you building?',
    options: [
      { label: 'CRM / sales tracking', lean: { relational: 2 }, template: 'CRM' },
      { label: 'Inventory / stock system', lean: { relational: 2 }, template: 'Inventory' },
      { label: 'ERP / accounting / HR', lean: { relational: 2 }, template: 'ERP' },
      { label: 'Marketplace / e-commerce', lean: { relational: 2 }, template: 'Marketplace' },
      { label: 'SaaS application', lean: { relational: 1, document: 1 }, template: 'SaaS' },
      { label: 'Content management (CMS)', lean: { document: 2 }, template: 'CMS' },
      { label: 'AI application / knowledge base', lean: { document: 2 }, signal: 'search', template: 'AI' },
      { label: 'Analytics / dashboard', lean: { relational: 1 }, signal: 'analytics', template: 'Analytics' },
      { label: 'File / document library', lean: { relational: 1 }, signal: 'files', template: 'Files' },
      { label: 'Something else', lean: {}, template: 'General' },
    ],
  },
  {
    id: 'users',
    prompt: 'Who will use it?',
    options: [
      { label: 'Just me', lean: { document: 1 } },
      { label: 'A small team', lean: { relational: 1, document: 1 } },
      { label: 'A whole department', lean: { relational: 1 } },
      { label: 'The entire company', lean: { relational: 2 } },
      { label: 'My customers / end users', lean: { relational: 1 } },
    ],
  },
  {
    id: 'structure',
    prompt: 'Which best describes your data?',
    options: [
      { label: 'Mostly tables & spreadsheets', lean: { relational: 3 } },
      { label: 'Forms with flexible / changing fields', lean: { document: 3 } },
      { label: 'Lots of connected relationships', lean: { relational: 2 }, signal: 'graph' },
      { label: 'Large files & documents', lean: { relational: 1 }, signal: 'files' },
      { label: 'Time-series / measurements', lean: { relational: 1 }, signal: 'analytics' },
      { label: 'A mix of these', lean: { relational: 1, document: 1 } },
    ],
  },
  {
    id: 'priority',
    prompt: 'What matters most?',
    options: [
      { label: 'Reliable records, transactions & consistency', lean: { relational: 3 }, signal: 'transactions' },
      { label: 'Fast iteration & a flexible schema', lean: { document: 3 } },
      { label: 'Reporting, dashboards & aggregation', lean: { relational: 2 }, signal: 'analytics' },
      { label: 'Search across content', lean: { document: 1 }, signal: 'search' },
      { label: 'Storing & sharing files', lean: { relational: 1 }, signal: 'files' },
      { label: 'Collaboration', lean: { relational: 1, document: 1 } },
    ],
  },
  {
    id: 'scale',
    prompt: 'How much data do you expect?',
    options: [
      { label: 'Under 10,000 records', lean: {} },
      { label: '10,000 – 1 million', lean: {} },
      { label: '1 – 100 million', lean: { relational: 1 } },
      { label: 'More than 100 million', lean: { relational: 1 }, signal: 'analytics' },
    ],
  },
];

const TEMPLATES: Record<string, { name: string; relational: string[]; document: string[] }> = {
  CRM: {
    name: 'CRM Starter',
    relational: ['Customers', 'Companies', 'Deals', 'Activities', 'Tasks'],
    document: ['customers', 'companies', 'deals', 'activities'],
  },
  Inventory: {
    name: 'Inventory Starter',
    relational: ['Products', 'Categories', 'Warehouses', 'StockMovements', 'Suppliers'],
    document: ['products', 'categories', 'stock_movements'],
  },
  ERP: {
    name: 'ERP Starter',
    relational: ['Accounts', 'Invoices', 'Orders', 'Products', 'Employees'],
    document: ['accounts', 'invoices', 'orders'],
  },
  Marketplace: {
    name: 'Marketplace Starter',
    relational: ['Users', 'Listings', 'Orders', 'Payments', 'Reviews'],
    document: ['users', 'listings', 'orders', 'reviews'],
  },
  SaaS: {
    name: 'SaaS Starter',
    relational: ['Accounts', 'Users', 'Subscriptions', 'Plans', 'UsageEvents'],
    document: ['accounts', 'users', 'settings', 'usage_events'],
  },
  CMS: {
    name: 'CMS Starter',
    relational: ['Pages', 'Posts', 'Media', 'Categories', 'Authors'],
    document: ['pages', 'posts', 'media', 'categories'],
  },
  AI: {
    name: 'AI Knowledge Starter',
    relational: ['Documents', 'Chunks', 'Conversations', 'Messages'],
    document: ['documents', 'conversations', 'messages', 'knowledge'],
  },
  Analytics: {
    name: 'Analytics Starter',
    relational: ['Events', 'Sources', 'Sessions', 'Metrics'],
    document: ['events', 'sources', 'metrics'],
  },
  Files: {
    name: 'File Library Starter',
    relational: ['Files', 'Folders', 'Tags', 'Shares'],
    document: ['files', 'folders', 'shares'],
  },
  General: {
    name: 'General Starter',
    relational: ['Items', 'Categories', 'Users'],
    document: ['items', 'categories'],
  },
};

function buildRecommendation(answers: Record<string, Option>): AdvisorRecommendation {
  let relational = 0;
  let document = 0;
  const signals = new Set<string>();
  for (const opt of Object.values(answers)) {
    relational += opt.lean.relational ?? 0;
    document += opt.lean.document ?? 0;
    if (opt.signal) signals.add(opt.signal);
  }

  const model: AdvisorModel = document > relational ? 'NOSQL' : 'RELATIONAL';
  const templateKey = answers.building?.template ?? 'General';
  const tpl = TEMPLATES[templateKey] ?? TEMPLATES.General;
  const entities = model === 'NOSQL' ? tpl.document : tpl.relational;

  const reasoning: string[] = [];
  if (model === 'RELATIONAL') {
    reasoning.push('Your data has a clear, repeating shape that fits well-defined tables.');
    if (signals.has('transactions'))
      reasoning.push('You need reliable records and consistency — a strength of this model.');
    if (signals.has('graph'))
      reasoning.push('Your records are highly connected; related tables capture those links cleanly.');
    if (signals.has('analytics'))
      reasoning.push('Reporting and aggregation run efficiently over structured tables.');
  } else {
    reasoning.push('Your records can vary and your fields will change over time.');
    reasoning.push('A flexible document model lets you evolve the shape without migrations.');
    if (signals.has('search'))
      reasoning.push('Document-centric content is a natural fit for your search-heavy use case.');
  }

  const scaleAnswer = answers.scale?.label ?? '';
  const scalability = /100 million/i.test(scaleAnswer)
    ? 'At this volume your project runs on a dedicated database; consider archiving or partitioning strategies as you grow.'
    : /1 . 100 million|1 – 100 million/i.test(scaleAnswer)
      ? 'This volume is comfortably handled by a dedicated database with proper indexes.'
      : 'This volume is well within a single project — no special scaling needed to start.';

  const note = signals.has('files')
    ? 'Heads up: large files (PDFs, images, video) should go in your project Storage, with the database holding the file metadata and links.'
    : undefined;

  return {
    model,
    title: model === 'RELATIONAL' ? 'Relational Database' : 'Document Database',
    reasoning,
    templateName: tpl.name,
    entities,
    alternative:
      model === 'RELATIONAL'
        ? 'Document model — if your fields will change often or each record can look different.'
        : 'Relational model — if your data settles into a fixed shape and you need joins or strict rules.',
    scalability,
    note,
  };
}

export function DatabaseAdvisor({
  onPick,
  onBack,
}: {
  onPick: (model: AdvisorModel, meta: { templateName: string; entities: string[] }) => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Option>>({});
  const [done, setDone] = useState(false);

  const total = QUESTIONS.length;
  const recommendation = useMemo(
    () => (done ? buildRecommendation(answers) : null),
    [done, answers],
  );

  function choose(q: Question, opt: Option) {
    const next = { ...answers, [q.id]: opt };
    setAnswers(next);
    if (step < total - 1) {
      setStep(step + 1);
    } else {
      setDone(true);
    }
  }

  function restart() {
    setStep(0);
    setAnswers({});
    setDone(false);
  }

  if (done && recommendation) {
    const isRel = recommendation.model === 'RELATIONAL';
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              isRel
                ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400'
                : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400'
            }`}
          >
            {isRel ? <Table2 className="h-5 w-5" /> : <FileJson className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              basefyio recommends
            </div>
            <h3 className="text-base font-semibold">{recommendation.title}</h3>
          </div>
        </div>

        <ul className="space-y-1.5">
          {recommendation.reasoning.map((line, i) => (
            <li key={i} className="flex gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <div className="rounded-lg border bg-muted/40 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">Suggested template</span>
            <Badge variant="secondary" className="text-[10px]">
              {recommendation.templateName}
            </Badge>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {isRel ? 'Starter tables' : 'Starter collections'}:
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {recommendation.entities.map((e) => (
              <span
                key={e}
                className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground/80 ring-1 ring-border"
              >
                {e}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Scale:</span> {recommendation.scalability}
          </p>
          <p>
            <span className="font-medium text-foreground">Alternative:</span>{' '}
            {recommendation.alternative}
          </p>
          {recommendation.note && (
            <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{recommendation.note}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={restart} className="text-xs">
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Start over
          </Button>
          <Button
            type="button"
            onClick={() =>
              onPick(recommendation.model, {
                templateName: recommendation.templateName,
                entities: recommendation.entities,
              })
            }
          >
            Use this — continue
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  const q = QUESTIONS[step];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => (step === 0 ? onBack() : setStep(step - 1))}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
          <Sparkles className="h-3.5 w-3.5" />
          basefyio advisor
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {step + 1} / {total}
        </span>
      </div>

      {/* progress */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${((step + 1) / total) * 100}%` }}
        />
      </div>

      <h3 className="text-base font-semibold">{q.prompt}</h3>

      <div className="space-y-2">
        {q.options.map((opt) => {
          const selected = answers[q.id]?.label === opt.label;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => choose(q, opt)}
              className={`flex w-full items-center justify-between rounded-lg border-2 px-3 py-2.5 text-left text-sm transition-all ${
                selected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'
              }`}
            >
              <span>{opt.label}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        No database jargon — just pick what fits. You can change everything later.
      </p>
    </div>
  );
}
