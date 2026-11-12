import { ImageResponse } from "next/og";

export const runtime = "edge";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * The home-screen icon iOS asks for. It must be a PNG, so it is drawn here from
 * the same shapes as icon.svg (brand gradient tile, white database glyph).
 * /apple-touch-icon.png, which iOS and crawlers request without reading any
 * <link>, is rewritten to this route in next.config.mjs.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 60%, #2563eb 100%)",
        }}
      >
        <svg width="112" height="112" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5V19A9 3 0 0 0 21 19V5" />
          <path d="M3 12A9 3 0 0 0 21 12" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
