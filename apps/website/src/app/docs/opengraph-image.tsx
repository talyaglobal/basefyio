import { ImageResponse } from "next/og";

export const runtime = "edge";

export const alt = "basefyio Docs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The docs share card: same brand gradient as the site card, labelled as documentation. */
export default function DocsOpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "0 96px",
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 55%, #1d4ed8 100%)",
          color: "white",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ fontSize: 34, fontWeight: 600, opacity: 0.85 }}>basefyio</div>
        <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 8 }}>
          Documentation
        </div>
        <div style={{ fontSize: 30, marginTop: 20, opacity: 0.9 }}>
          Database · Auth · Storage · REST API · SDK · CLI
        </div>
      </div>
    ),
    { ...size },
  );
}
