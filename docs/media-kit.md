# Media Kit — Brand Colors

These values are extracted **from the actual product** — the Admin UI theme tokens
in [`apps/admin-ui/app/globals.css`](../apps/admin-ui/app/globals.css) (consumed via
[`apps/admin-ui/tailwind.config.ts`](../apps/admin-ui/tailwind.config.ts)). Use these
for launch assets, screenshots, and press material so the media kit matches what ships.

> **Honest note:** the v0.1 Admin UI currently uses the stock **shadcn/ui "slate"**
> theme (Tailwind `slate` scale + `red` for destructive). This is the real palette
> in use today, but it is **not yet a customized brand identity**. Treat it as the
> current product palette, not a finalized brand. A distinct brand palette is a
> planned follow-up.

The tokens are defined in HSL. Hex equivalents below are provided for design tools.

## Light mode

| Token | HSL | Hex | Tailwind ref |
|---|---|---|---|
| `background` | `0 0% 100%` | `#FFFFFF` | white |
| `foreground` | `222.2 84% 4.9%` | `#020817` | slate-950 |
| `primary` | `222.2 47.4% 11.2%` | `#0F172A` | slate-900 |
| `primary-foreground` | `210 40% 98%` | `#F8FAFC` | slate-50 |
| `secondary` / `muted` / `accent` | `210 40% 96.1%` | `#F1F5F9` | slate-100 |
| `muted-foreground` | `215.4 16.3% 46.9%` | `#64748B` | slate-500 |
| `border` / `input` | `214.3 31.8% 91.4%` | `#E2E8F0` | slate-200 |
| `destructive` | `0 84.2% 60.2%` | `#EF4444` | red-500 |
| `ring` | `222.2 84% 4.9%` | `#020817` | slate-950 |

## Dark mode

| Token | HSL | Hex | Tailwind ref |
|---|---|---|---|
| `background` / `card` / `popover` | `222.2 47.4% 11.2%` | `#0F172A` | slate-900 |
| `foreground` | `210 40% 98%` | `#F8FAFC` | slate-50 |
| `primary` | `210 40% 98%` | `#F8FAFC` | slate-50 |
| `primary-foreground` | `222.2 47.4% 11.2%` | `#0F172A` | slate-900 |
| `secondary` / `muted` / `accent` / `border` / `input` | `217.2 32.6% 17.5%` | `#1E293B` | slate-800 |
| `muted-foreground` | `215 20.2% 65.1%` | `#94A3B8` | slate-400 |
| `destructive` | `0 62.8% 30.6%` | `#7F1D1D` | red-900 |
| `ring` | `212.7 26.8% 83.9%` | `#CBD5E1` | slate-300 |

## Quick reference (core palette)

- **Ink / primary (light):** `#0F172A` (slate-900)
- **Surface (light):** `#FFFFFF` / **Surface (dark):** `#0F172A`
- **Text (light):** `#020817` / **Text (dark):** `#F8FAFC`
- **Muted text:** `#64748B` (light) · `#94A3B8` (dark)
- **Borders:** `#E2E8F0` (light) · `#1E293B` (dark)
- **Accent radius:** `--radius: 0.5rem`

> Hex values are computed from the HSL tokens and map cleanly onto Tailwind's `slate`
> scale; if the tokens in `globals.css` change, re-extract this table from source.
