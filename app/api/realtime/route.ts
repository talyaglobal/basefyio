import { NextRequest } from "next/server"
import { getUser } from "@/lib/auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const user = await getUser()
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
  }

  const { searchParams } = new URL(request.url)
  const table = searchParams.get("table") || "public"

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (event: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      const interval = setInterval(() => {
        // heartbeat
        controller.enqueue(encoder.encode(": keep-alive\n\n"))
      }, 30000)

      // demo event ticker
      const demo = setInterval(() => {
        send({ type: "PING", table, at: new Date().toISOString() })
      }, 5000)

      // close handler
      const close = () => {
        clearInterval(interval)
        clearInterval(demo)
        controller.close()
      }

      // abort handling
      // @ts-ignore
      request.signal.addEventListener("abort", close)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  })
}



