import { NextRequest, NextResponse } from "next/server"
import { 
  requireScopes, 
  validateRequestBody, 
  createInternalError, 
  securityHeaders,
  getDatabaseConnection
} from "@/lib/api-utils"
import { sqlExecuteSchema } from "@/lib/validation-schemas"
import { isSqlWriteOperation } from "@/lib/api-key-utils"

export async function POST(request: NextRequest) {
  try {
    const validation = await validateRequestBody(request, sqlExecuteSchema)
    if (!validation.success) {
      return validation.error
    }

    const { query, params = [], readOnly = false, database_id } = validation.data

    // Determine required scopes based on query type
    const isWriteOperation = isSqlWriteOperation(query)
    const requiredScope = isWriteOperation ? "write:sql" : "read:sql"

    const auth = await requireScopes([requiredScope])
    if (!auth.success) {
      return auth.error
    }

    // If readOnly flag is set, ensure it's actually a read operation
    if (readOnly && isWriteOperation) {
      return NextResponse.json({
        code: "INVALID_QUERY_TYPE",
        message: "Query marked as read-only but contains write operations",
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    // Get database connection (dynamic or default)
    const { safeDb } = await getDatabaseConnection(database_id)

    // Determine query execution options
    const isAdminUser = auth.user.authMethod === "session"
    const queryOptions = {
      timeout: 30000, // 30 second timeout
      maxRows: readOnly ? 10000 : 1000,
      allowDDL: isAdminUser, // Only session users can run DDL
      allowDML: !readOnly,
      adminOverride: false, // Never use admin override for user queries
    }

    // Execute query with safety measures
    const result = await safeDb.query(query, params, queryOptions)

    // Extract column names if results exist
    let columns: string[] = []
    if (result.rows.length > 0 && typeof result.rows[0] === 'object') {
      columns = Object.keys(result.rows[0])
    }

    const response = {
      success: true,
      rows: result.rows,
      columns,
      rowCount: result.rowCount,
      executionTime: result.executionTime,
    }

    // Include warnings if any
    if (result.warnings && result.warnings.length > 0) {
      Object.assign(response, { warnings: result.warnings })
    }

    return NextResponse.json(response, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("SQL execution error:", error)
    
    // Check if it's a safety-related error
    if (error.message.includes('Query blocked') || 
        error.message.includes('timeout') || 
        error.message.includes('dangerous')) {
      return NextResponse.json({
        code: "QUERY_SAFETY_VIOLATION",
        message: error.message,
      }, { 
        status: 403,
        headers: securityHeaders()
      })
    }

    return createInternalError(`Failed to execute query: ${error.message}`)
  }
}
