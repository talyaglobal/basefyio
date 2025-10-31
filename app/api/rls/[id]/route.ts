import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { updateRlsSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:rls"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can delete RLS policies
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "RLS policy deletion requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const { id } = await params
    const [table, policyName] = id.split(":")

    if (!table || !policyName) {
      return NextResponse.json({
        code: "INVALID_POLICY_ID",
        message: "Policy ID must be in format 'table:policyName'"
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Sanitize input
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, '')
    const sanitizedPolicyName = policyName.replace(/[^a-zA-Z0-9_]/g, '')

    // Execute DROP POLICY with admin permissions
    await safeDb.adminQuery(
      `DROP POLICY IF EXISTS "${sanitizedPolicyName}" ON "${sanitizedTable}"`,
      [],
      {
        timeout: 30000,
        allowDDL: true,
        allowDML: false
      }
    )

    // Log policy deletion
    await safeDb.safeInsert(`
      INSERT INTO rls_policy_log (table_name, policy_name, action, created_by, created_at)
      VALUES ($1, $2, 'DELETE', $3, NOW())
    `, [sanitizedTable, sanitizedPolicyName, auth.user.id])

    return NextResponse.json({ 
      success: true, 
      message: "RLS policy deleted successfully"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error deleting RLS policy:", error)
    return createInternalError("Failed to delete RLS policy")
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:rls"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can update RLS policies
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "RLS policy updates require session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const { id } = await params
    const [table, oldPolicyName] = id.split(":")

    if (!table || !oldPolicyName) {
      return NextResponse.json({
        code: "INVALID_POLICY_ID",
        message: "Policy ID must be in format 'table:policyName'"
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, updateRlsSchema)
    if (!validation.success) {
      return validation.error
    }

    const { name, type, roles = [], expression, enabled } = validation.data

    // Sanitize input
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, '')
    const sanitizedOldName = oldPolicyName.replace(/[^a-zA-Z0-9_]/g, '')
    const sanitizedNewName = (name || oldPolicyName).replace(/[^a-zA-Z0-9_]/g, '')

    // Use transaction for atomic update
    await safeDb.transaction(async (db) => {
      // Drop old policy
      await db.adminQuery(
        `DROP POLICY IF EXISTS "${sanitizedOldName}" ON "${sanitizedTable}"`,
        [],
        {
          timeout: 30000,
          allowDDL: true,
          allowDML: false
        }
      )

      // Only create new policy if enabled is not false
      if (enabled !== false) {
        // Create new policy
        const rolesStr = roles.length > 0 ? roles.join(", ") : "public"

        let policyQuery = `CREATE POLICY "${sanitizedNewName}" ON "${sanitizedTable}"`

        if (type && type !== "ALL") {
          policyQuery += ` FOR ${type}`
        }

        policyQuery += ` TO ${rolesStr}`
        
        if (expression) {
          policyQuery += ` USING (${expression})`
        }

        await db.adminQuery(policyQuery, [], {
          timeout: 30000,
          allowDDL: true,
          allowDML: false
        })
      }

      // Log policy update
      await db.safeInsert(`
        INSERT INTO rls_policy_log (table_name, policy_name, action, created_by, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [sanitizedTable, sanitizedNewName, enabled === false ? 'DISABLE' : 'UPDATE', auth.user.id])

    }, {
      adminOverride: true
    })

    return NextResponse.json({ 
      success: true, 
      message: "RLS policy updated successfully",
      policy: {
        table: sanitizedTable,
        name: sanitizedNewName,
        type,
        roles,
        expression,
        enabled: enabled !== false
      }
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error updating RLS policy:", error)
    
    // Check for specific error conditions
    if (error.message.includes('already exists')) {
      return NextResponse.json({
        code: "POLICY_EXISTS",
        message: "A policy with this name already exists for this table"
      }, { 
        status: 409,
        headers: securityHeaders()
      })
    }

    return createInternalError("Failed to update RLS policy")
  }
}
