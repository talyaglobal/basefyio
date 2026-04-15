import { ImageResponse } from "next/og";

export const runtime = "edge";

export const alt = "Kolaybase — Backend as a Service";
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
        <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Kolaybase
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
