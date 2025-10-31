import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { z } from "zod"
import { edgeFunctionRuntime, FUNCTION_TEMPLATES } from "@/lib/edge-functions"

// Force Node.js runtime for this route since it uses child_process
export const runtime = 'nodejs'

const createFunctionSchema = z.object({
  name: z.string().min(1, "Function name is required"),
  slug: z.string().min(1, "Function slug is required").regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
  description: z.string().optional(),
  runtime: z.enum(["deno", "node"]).default("deno"),
  source_code: z.string().min(1, "Source code is required"),
  environment_variables: z.record(z.string()).default({}),
  timeout_ms: z.number().min(1000).max(300000).default(30000),
  memory_limit_mb: z.number().min(64).max(1024).default(128),
  template: z.string().optional()
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const offset = parseInt(searchParams.get('offset') || '0')
    const isActive = searchParams.get('active')

    let query = `
      SELECT id, name, slug, description, runtime, timeout_ms, memory_limit_mb,
             is_active, version, created_at, updated_at, deployed_at
      FROM edge_functions 
      WHERE created_by = $1
    `
    const params: any[] = [auth.user.id]

    if (isActive !== null) {
      query += ` AND is_active = $${params.length + 1}`
      params.push(isActive === 'true')
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const result = await safeDb.safeSelect(query, params)

    // Get invocation metrics for each function
    const functionsWithMetrics = await Promise.all(
      result.rows.map(async (func: any) => {
        const metrics = await edgeFunctionRuntime.getFunctionMetrics(func.id)
        return {
          ...func,
          metrics
        }
      })
    )

    return NextResponse.json({
      functions: functionsWithMetrics,
      total: result.rows.length
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error fetching edge functions:", error)
    return createInternalError("Failed to fetch functions")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    
    // If template is specified, use template source code
    if (body.template && FUNCTION_TEMPLATES[body.template as keyof typeof FUNCTION_TEMPLATES]) {
      const template = FUNCTION_TEMPLATES[body.template as keyof typeof FUNCTION_TEMPLATES]
      body.source_code = template.source_code
      body.runtime = template.runtime
      if (!body.name) body.name = template.name
      if (!body.description) body.description = template.description
    }

    const validation = createFunctionSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "Invalid function data",
        errors: validation.error.errors
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const { name, slug, description, runtime, source_code, environment_variables, timeout_ms, memory_limit_mb } = validation.data

    // Check if slug already exists
    const existingResult = await safeDb.safeSelect(`
      SELECT id FROM edge_functions WHERE slug = $1
    `, [slug])

    if (existingResult.rows.length > 0) {
      return NextResponse.json({
        code: "SLUG_EXISTS",
        message: "A function with this slug already exists"
      }, { 
        status: 409,
        headers: securityHeaders()
      })
    }

    const result = await safeDb.safeInsert(`
      INSERT INTO edge_functions (
        name, slug, description, runtime, source_code, environment_variables,
        timeout_ms, memory_limit_mb, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id, name, slug, description, runtime, timeout_ms, memory_limit_mb,
                is_active, version, created_at
    `, [
      name,
      slug,
      description,
      runtime,
      source_code,
      JSON.stringify(environment_variables),
      timeout_ms,
      memory_limit_mb,
      auth.user.id
    ])

    const edgeFunction = result.rows[0]

    // Deploy the function
    await edgeFunctionRuntime.deployFunction({
      ...edgeFunction,
      environment_variables,
      source_code
    })

    return NextResponse.json({
      success: true,
      function: edgeFunction
    }, {
      status: 201,
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error creating edge function:", error)
    return createInternalError("Failed to create function")
  }
}

// Get available templates
export async function OPTIONS() {
  return NextResponse.json({
    templates: Object.entries(FUNCTION_TEMPLATES).map(([key, template]) => ({
      id: key,
      name: template.name,
      description: template.description,
      runtime: template.runtime
    }))
  }, {
    headers: securityHeaders()
  })
}