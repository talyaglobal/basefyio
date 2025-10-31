import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { dbManager } from "@/lib/database-manager"
import { quotaManager } from "@/lib/resource-quotas"
import { z } from "zod"

const createReplicaSchema = z.object({
  name: z.string().min(1, "Replica name is required").max(50),
  region: z.string().min(1, "Region is required"),
  readonly: z.boolean().default(true),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Check if user has replica feature enabled
    const quota = await quotaManager.getUserQuota(auth.user.id)
    if (!quota.features.enableReplicas) {
      return NextResponse.json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Replica feature is not available in your current plan"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const replicas = await dbManager.listReplicas()

    return NextResponse.json({
      replicas,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching replicas:", error)
    return createInternalError("Failed to fetch replicas")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can create replicas
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Replica creation requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Check if user has replica feature enabled
    const quota = await quotaManager.getUserQuota(auth.user.id)
    if (!quota.features.enableReplicas) {
      return NextResponse.json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Replica feature is not available in your current plan"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, createReplicaSchema)
    if (!validation.success) {
      return validation.error
    }

    const { name, region, readonly } = validation.data

    // Check if user already has too many replicas
    const existingReplicas = await dbManager.listReplicas()
    const maxReplicas = quota.features.enableReplicas ? 3 : 0 // Pro gets 3 replicas
    
    if (existingReplicas.length >= maxReplicas) {
      return NextResponse.json({
        code: "REPLICA_LIMIT_EXCEEDED",
        message: `Maximum number of replicas reached (${maxReplicas})`
      }, { 
        status: 409,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Create replica
    const replicaId = await dbManager.createReplica(name, region)

    return NextResponse.json({
      success: true,
      replicaId,
      message: "Replica creation initiated",
    }, {
      status: 202, // Accepted - replica is being created
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating replica:", error)
    return createInternalError("Failed to create replica")
  }
}