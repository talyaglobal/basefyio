/**
 * Generators for the `llms.txt` family (see https://llmstxt.org).
 *
 * `llms.txt` is a curated, Markdown map of a site written for LLMs: the name, a
 * one-line summary, then sections of links to the pages most worth citing.
 * `llms-full.txt` inlines the actual answer-bearing content (FAQs, facts, how-tos)
 * so an engine can quote you without a second fetch.
 *
 * Both are deterministic, pure string builders — no IO, no framework.
 */
import type { GeoProfile, GeoLink } from './types.js';

/** Resolve a possibly-relative link against the profile origin. */
function absolute(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${base.replace(/\/$/, '')}${path}`;
}

function linkLine(link: GeoLink, base: string): string {
  const href = absolute(link.url, base);
  return link.note
    ? `- [${link.title}](${href}): ${link.note}`
    : `- [${link.title}](${href})`;
}

/**
 * Build `llms.txt`: H1 name, blockquote summary, optional sections of links.
 * This is the lightweight manifest engines fetch first.
 */
export function generateLlmsTxt(profile: GeoProfile): string {
  const out: string[] = [];
  out.push(`# ${profile.name}`);
  out.push('');
  out.push(`> ${profile.summary}`);

  if (profile.description) {
    out.push('');
    out.push(profile.description);
  }

  if (profile.facts?.length) {
    out.push('');
    out.push('## Key facts');
    out.push('');
    for (const f of profile.facts) out.push(`- **${f.label}:** ${f.value}`);
  }

  for (const section of profile.sections ?? []) {
    out.push('');
    out.push(`## ${section.title}`);
    if (section.description) {
      out.push('');
      out.push(section.description);
    }
    out.push('');
    for (const link of section.links) out.push(linkLine(link, profile.url));
  }

  if (profile.notes?.length) {
    out.push('');
    out.push('## Notes');
    out.push('');
    for (const note of profile.notes) out.push(`- ${note}`);
  }

  return out.join('\n') + '\n';
}

/**
 * Build `llms-full.txt`: everything in `llms.txt` plus the inlined,
 * answer-bearing content (FAQs and how-tos) so an engine can quote directly.
 */
export function generateLlmsFullTxt(profile: GeoProfile): string {
  const out: string[] = [generateLlmsTxt(profile).trimEnd()];

  if (profile.faqs?.length) {
    out.push('');
    out.push('## Frequently asked questions');
    for (const faq of profile.faqs) {
      out.push('');
      out.push(`### ${faq.question}`);
      out.push('');
      out.push(faq.answer);
    }
  }

  if (profile.howtos?.length) {
    for (const howto of profile.howtos) {
      out.push('');
      out.push(`## How to: ${howto.name}`);
      if (howto.description) {
        out.push('');
        out.push(howto.description);
      }
      out.push('');
      howto.steps.forEach((step, i) => {
        const suffix = step.url ? ` (${absolute(step.url, profile.url)})` : '';
        out.push(`${i + 1}. **${step.name}** — ${step.text}${suffix}`);
      });
    }
  }

  return out.join('\n') + '\n';
}
