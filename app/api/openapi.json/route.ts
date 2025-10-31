import { NextResponse } from "next/server"
import { specs } from "@/lib/openapi-config"
import { securityHeaders } from "@/lib/api-utils"

/**
 * @swagger
 * /api/openapi.json:
 *   get:
 *     tags: [System]
 *     summary: Get OpenAPI specification
 *     description: Returns the OpenAPI 3.0 specification for this API
 *     responses:
 *       200:
 *         description: OpenAPI specification
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
export async function GET() {
  return NextResponse.json(specs, {
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json",
    },
  })
}