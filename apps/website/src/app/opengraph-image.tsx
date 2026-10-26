import { ImageResponse } from "next/og";
import { isBeta, RELEASE_LABEL } from "@/lib/release-stage";

export const runtime = "edge";

export const alt = "basefyio — Backend as a Service";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 60%, #2563eb 100%)",
          color: "white",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: "-0.02em" }}>
            basefyio
          </div>
          {isBeta() && (
            <div
              style={{
                fontSize: 24,
                fontWeight: 600,
                padding: "4px 14px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.18)",
                border: "1px solid rgba(255,255,255,0.45)",
              }}
            >
              {RELEASE_LABEL}
            </div>
          )}
        </div>
        <div
          style={{
            fontSize: 28,
            marginTop: 16,
            opacity: 0.95,
            fontWeight: 500,
          }}
        >
          Backend as a Service
        </div>
      </div>
    ),
    { ...size },
  );
}
