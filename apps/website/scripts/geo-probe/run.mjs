#!/usr/bin/env node
/**
 * Ask the assistants the questions buyers ask, and record whether basefyio is
 * named, which competitors are, and which sources they cite.
 *
 *   node scripts/geo-probe/run.mjs            # query every provider that has a key
 *   DRY_RUN=1 node scripts/geo-probe/run.mjs  # print what would be asked, call nothing
 *
 * Keys (a provider without its key is skipped; every call is a paid API request):
 *   OPENAI_API_KEY      (model: GEO_OPENAI_MODEL,     default gpt-4o-mini)
 *   ANTHROPIC_API_KEY   (model: GEO_ANTHROPIC_MODEL,  default claude-sonnet-5-5)
 *   GEMINI_API_KEY      (model: GEO_GEMINI_MODEL,     default gemini-2.0-flash)
 *   PERPLEXITY_API_KEY  (model: GEO_PERPLEXITY_MODEL, default sonar)   — answers carry citations
 *   DEEPSEEK_API_KEY    (model: GEO_DEEPSEEK_MODEL,   default deepseek-chat)
 *
 * Honest limits: these are API calls, not the consumer chat apps. Without web
 * search a model answers from training data, so a result here is a proxy for
 * "what the assistant knows", and only Perplexity's answers are search-grounded.
 * Model names change; override them with the GEO_*_MODEL variables.
 *
 * Output: scripts/geo-probe/results/<date>.jsonl (one line per provider+prompt)
 * and a summary table on stdout. The results folder is git-ignored.
 */
import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8"));
const DRY = process.env.DRY_RUN === "1";
const env = (k, d) => process.env[k] || d;

async function post(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const PROVIDERS = [
  {
    name: "chatgpt-api", key: "OPENAI_API_KEY",
    ask: async (q, k) => {
      const j = await post("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${k}` },
        { model: env("GEO_OPENAI_MODEL", "gpt-4o-mini"), messages: [{ role: "user", content: q }] });
      return { text: j.choices?.[0]?.message?.content ?? "", citations: [] };
    },
  },
  {
    name: "claude-api", key: "ANTHROPIC_API_KEY",
    ask: async (q, k) => {
      const j = await post("https://api.anthropic.com/v1/messages", { "x-api-key": k, "anthropic-version": "2023-06-01" },
        { model: env("GEO_ANTHROPIC_MODEL", "claude-sonnet-5-5"), max_tokens: 1024, messages: [{ role: "user", content: q }] });
      return { text: (j.content ?? []).map((c) => c.text ?? "").join(""), citations: [] };
    },
  },
  {
    name: "gemini-api", key: "GEMINI_API_KEY",
    ask: async (q, k) => {
      const m = env("GEO_GEMINI_MODEL", "gemini-2.0-flash");
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`, {},
        { contents: [{ parts: [{ text: q }] }] });
      return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "", citations: [] };
    },
  },
  {
    name: "perplexity-api", key: "PERPLEXITY_API_KEY",
    ask: async (q, k) => {
      const j = await post("https://api.perplexity.ai/chat/completions", { authorization: `Bearer ${k}` },
        { model: env("GEO_PERPLEXITY_MODEL", "sonar"), messages: [{ role: "user", content: q }] });
      return { text: j.choices?.[0]?.message?.content ?? "", citations: j.citations ?? [] };
    },
  },
  {
    name: "deepseek-api", key: "DEEPSEEK_API_KEY",
    ask: async (q, k) => {
      const j = await post("https://api.deepseek.com/chat/completions", { authorization: `Bearer ${k}` },
        { model: env("GEO_DEEPSEEK_MODEL", "deepseek-chat"), messages: [{ role: "user", content: q }] });
      return { text: j.choices?.[0]?.message?.content ?? "", citations: [] };
    },
  },
];

const active = PROVIDERS.filter((p) => process.env[p.key]);
const skipped = PROVIDERS.filter((p) => !process.env[p.key]).map((p) => p.name);
console.log(`${cfg.prompts.length} prompts x ${active.length} providers = ${cfg.prompts.length * active.length} paid calls`);
if (skipped.length) console.log(`skipped (no key): ${skipped.join(", ")}`);
if (DRY) {
  cfg.prompts.forEach((p, i) => console.log(`${i + 1}. ${p}`));
  console.log("DRY_RUN: nothing sent");
  process.exit(0);
}
if (!active.length) { console.error("no provider key set"); process.exit(2); }

const date = new Date().toISOString().slice(0, 10);
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${date}.jsonl`);
const brand = new RegExp(`\\b${cfg.brand}\\b`, "i");
const tally = {};

for (const p of active) {
  tally[p.name] = { asked: 0, mentioned: 0, cited: 0, errors: 0 };
  for (const q of cfg.prompts) {
    const t = tally[p.name];
    t.asked++;
    try {
      const { text, citations } = await p.ask(q, process.env[p.key]);
      const mentioned = brand.test(text);
      const cited = citations.some((u) => cfg.domains.some((d) => u.includes(d)));
      const competitors = cfg.competitors.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
      if (mentioned) t.mentioned++;
      if (cited) t.cited++;
      appendFileSync(outFile, JSON.stringify({ date, provider: p.name, prompt: q, mentioned, cited, competitors, citations, text }) + "\n");
    } catch (e) {
      t.errors++;
      console.error(`${p.name}: ${e.message}`);
    }
  }
}

console.log(`\nprovider           asked  named  cited  errors`);
for (const [n, t] of Object.entries(tally)) {
  console.log(`${n.padEnd(18)} ${String(t.asked).padStart(5)} ${String(t.mentioned).padStart(6)} ${String(t.cited).padStart(6)} ${String(t.errors).padStart(7)}`);
}
console.log(`\nfull answers: ${outFile}`);
