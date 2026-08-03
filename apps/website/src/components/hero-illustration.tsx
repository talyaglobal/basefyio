/**
 * Hero illustration — a team driving growth, drawn in the brand palette.
 *
 * Deliberately hand-authored SVG rather than a stock asset: it inherits the
 * theme's blues and amber, carries no watermark or third-party licence, ships
 * as a few KB of markup, and stays crisp at any size in both light and dark.
 */
export function HeroIllustration() {
  return (
    <div className="relative">
      {/* Soft brand glow behind the scene */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-8 rounded-[2rem] opacity-60 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 60% at 55% 45%, rgba(37,99,235,0.22), transparent 70%)",
        }}
      />

      <svg
        viewBox="0 0 640 520"
        className="relative w-full drop-shadow-sm"
        role="img"
        aria-label="A team celebrating growth on a rising arrow, with turning gears representing an automated backend"
      >
        <defs>
          <linearGradient id="bf-arrow" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#1e3a8a" />
            <stop offset="60%" stopColor="#1d4ed8" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="bf-gear" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#60a5fa" />
          </linearGradient>
          <linearGradient id="bf-gear-deep" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
        </defs>

        {/* Backdrop blob */}
        <path
          d="M96 372c-52-30-72-96-46-150 25-52 92-72 150-88 66-18 128-46 190-30 66 17 116 74 128 140 11 62-16 128-66 166-52 40-124 42-190 34-62-8-118-42-166-72Z"
          className="fill-slate-200/70 dark:fill-slate-700/30"
        />

        {/* Rising arrow */}
        <path
          d="M92 430 L92 388 L300 214 L300 176 L214 176 L214 132 L392 132 L392 300 L348 300 L348 214 L134 430 Z"
          fill="url(#bf-arrow)"
        />

        {/* Ground line */}
        <rect
          x="64"
          y="440"
          width="512"
          height="12"
          rx="6"
          className="fill-slate-800 dark:fill-slate-200"
        />

        {/* ── Gears ─────────────────────────────────────────────── */}
        <Gear cx={252} cy={306} r={72} teeth={12} fill="url(#bf-gear)" spin={26} />
        <Gear cx={410} cy={330} r={54} teeth={10} fill="url(#bf-gear-deep)" spin={-18} />
        <Gear cx={318} cy={404} r={40} teeth={9} fill="url(#bf-gear)" spin={20} />

        {/* ── Figure: planting the flag at the summit ───────────── */}
        <g transform="translate(236,120)">
          {/* flag */}
          <path
            d="M0 0 L0 -74"
            stroke="#f59e0b"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path d="M2 -72 C 26 -64, 44 -78, 62 -66 L 62 -40 C 44 -52, 26 -38, 2 -46 Z" fill="#f59e0b" />
          {/* seated person */}
          <circle cx="6" cy="18" r="13" className="fill-slate-800 dark:fill-slate-100" />
          <path
            d="M-8 34 h30 a10 10 0 0 1 10 10 v20 h-50 v-20 a10 10 0 0 1 10 -10 Z"
            className="fill-slate-800 dark:fill-slate-100"
          />
          <path
            d="M-18 64 h52 v10 a8 8 0 0 1 -8 8 h-36 a8 8 0 0 1 -8 -8 Z"
            fill="#1d4ed8"
          />
        </g>

        {/* ── Figure: standing on the arrow, arms raised ────────── */}
        <g transform="translate(452,150)">
          <circle cx="0" cy="0" r="14" className="fill-slate-800 dark:fill-slate-100" />
          <path
            d="M-14 20 h28 a10 10 0 0 1 10 10 v34 h-48 v-34 a10 10 0 0 1 10 -10 Z"
            fill="#f59e0b"
          />
          {/* raised arms */}
          <path
            d="M-16 26 L-34 -2 M16 26 L34 -2"
            stroke="#f59e0b"
            strokeWidth="9"
            strokeLinecap="round"
          />
          {/* legs */}
          <path
            d="M-8 64 v34 M8 64 v34"
            className="stroke-slate-800 dark:stroke-slate-100"
            strokeWidth="10"
            strokeLinecap="round"
          />
        </g>

        {/* ── Figure: at ground level, looking up ───────────────── */}
        <g transform="translate(150,332)">
          <circle cx="0" cy="0" r="14" className="fill-slate-800 dark:fill-slate-100" />
          <path
            d="M-14 20 h28 a10 10 0 0 1 10 10 v40 h-48 v-40 a10 10 0 0 1 10 -10 Z"
            fill="#f59e0b"
          />
          <path
            d="M-8 70 v36 M8 70 v36"
            fill="none"
            stroke="#1d4ed8"
            strokeWidth="11"
            strokeLinecap="round"
          />
        </g>

        {/* Birds — a little motion in the sky */}
        <g
          className="stroke-slate-500/70 dark:stroke-slate-400/70"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M470 74 q10 -9 20 0 q10 -9 20 0" />
          <path d="M528 116 q8 -7 16 0 q8 -7 16 0" />
          <path d="M96 150 q8 -7 16 0 q8 -7 16 0" />
        </g>
      </svg>
    </div>
  );
}

/**
 * One gear: a toothed ring with a hub. `spin` is the animation duration in
 * seconds — negative values turn the other way, so meshing gears look right.
 */
function Gear({
  cx,
  cy,
  r,
  teeth,
  fill,
  spin,
}: {
  cx: number;
  cy: number;
  r: number;
  teeth: number;
  fill: string;
  spin: number;
}) {
  const toothW = (r * 2 * Math.PI) / teeth / 2.4;
  const toothH = r * 0.26;

  return (
    <g>
      <g style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${cx} ${cy}`}
          to={`${spin > 0 ? 360 : -360} ${cx} ${cy}`}
          dur={`${Math.abs(spin)}s`}
          repeatCount="indefinite"
        />
        {Array.from({ length: teeth }).map((_, i) => (
          <rect
            key={i}
            x={cx - toothW / 2}
            y={cy - r - toothH * 0.62}
            width={toothW}
            height={toothH}
            rx={toothW * 0.28}
            fill={fill}
            transform={`rotate(${(360 / teeth) * i} ${cx} ${cy})`}
          />
        ))}
        <circle cx={cx} cy={cy} r={r} fill={fill} />
        <circle
          cx={cx}
          cy={cy}
          r={r * 0.62}
          fill="none"
          className="stroke-white/70 dark:stroke-slate-900/30"
          strokeWidth={r * 0.07}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r * 0.3}
          className="fill-white/85 dark:fill-slate-900/40"
        />
      </g>
    </g>
  );
}
