import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS home-screen icon, also served at /apple-touch-icon.png (see next.config.mjs). */
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
          background: "linear-gradient(135deg, #1e3a8a, #2563eb)",
          color: "white",
          fontSize: 120,
          fontWeight: 700,
        }}
      >
        b
      </div>
    ),
    size,
  );
}
