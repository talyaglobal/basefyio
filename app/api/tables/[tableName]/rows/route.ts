import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { 
  requireScopes, 
  validateRequestBody, 
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { 
  tableQuerySchema, 
  createTableRowSchema, 
  updateTableRowSchema,
  paginationSchema
} from "@/lib/validation-schemas"
import { PaginationBuilder } from "@/lib/pagination-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const auth = await requireScopes(["read:tables"])
    if (!auth.success) {
      return auth.error
    }

    const { tableName } = await params
    
    // Sanitize table name to prevent SQL injection
    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '')
    if (sanitizedTableName !== tableName || !sanitizedTableName) {
      return NextResponse.json({ 
        error: "Invalid table name" 
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const { searchParams } = new URL(request.url)
    
    const validation = validateSearchParams(
      searchParams, 
      tableQuerySchema.merge(paginationSchema)
    )
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor, select, where, orderBy } = validation.data

    let baseQuery = `SELECT ${select || "*"} FROM "${sanitizedTableName}"`

    const builder = new PaginationBuilder(sql, sanitizedTableName, baseQuery)

    if (where) {
      builder.where(where)
    }

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: orderBy?.split(" ")[0] || "id",
      sortOrder: orderBy?.includes("DESC") ? "desc" : "asc"
    })

    return NextResponse.json({
      rows: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error fetching rows:", error)
    return createInternalError("Failed to fetch rows")
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const auth = await requireScopes(["write:tables"])
    if (!auth.success) {
      return auth.error
    }

    const { tableName } = await params
    
    // Sanitize table name to prevent SQL injection
    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '')
    if (sanitizedTableName !== tableName || !sanitizedTableName) {
      return NextResponse.json({ 
        error: "Invalid table name" 
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const validation = await validateRequestBody(request, createTableRowSchema)
    if (!validation.success) {
      return validation.error
    }

    const { data } = validation.data

    const columns = Object.keys(data)
    const values = Object.values(data)
    
    // For now, use a simpler approach that works with Neon
    if (columns.length === 0) {
      throw new Error("No data provided")
    }
    
    // Use inline parameter replacement like UPDATE and DELETE methods
    const columnsStr = columns.map(col => `"${col}"`).join(', ')
    const valuesStr = values.map(v => {
      if (typeof v === 'string') {
        return `'${v.replace(/'/g, "''")}'`
      } else if (v === null) {
        return 'NULL'
      } else {
        return String(v)
      }
    }).join(', ')
    
    const insertQuery = `INSERT INTO "${sanitizedTableName}" (${columnsStr}) VALUES (${valuesStr}) RETURNING *`
    const result = await sql.unsafe(insertQuery)
    
    return NextResponse.json({ 
      success: true, 
      row: Array.isArray(result) ? result[0] : result
    }, {
      status: 201,
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error adding row:", error)
    return createInternalError("Failed to add row")
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const auth = await requireScopes(["write:tables"])
    if (!auth.success) {
      return auth.error
    }

    const { tableName } = await params
    
    // Sanitize table name to prevent SQL injection
    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '')
    if (sanitizedTableName !== tableName || !sanitizedTableName) {
      return NextResponse.json({ 
        error: "Invalid table name" 
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const validation = await validateRequestBody(request, updateTableRowSchema)
    if (!validation.success) {
      return validation.error
    }

    const { data, where } = validation.data

    const updates = Object.entries(data)
      .filter(([key]) => key !== "id" && key !== "created_at")
      .map(([key], i) => `${key} = $${i + 1}`)
      .join(", ")

    const values = Object.entries(data)
      .filter(([key]) => key !== "id" && key !== "created_at")
      .map(([, value]) => value)

    let whereClause = "id = $" + (values.length + 1)
    let whereValues = [data.id || where?.id]

    if (where && Object.keys(where).length > 0) {
      const whereConditions = Object.entries(where)
        .map(([key], i) => `${key} = $${values.length + i + 1}`)
        .join(" AND ")
      whereClause = whereConditions
      whereValues = Object.values(where)
    }

    const query = `UPDATE "${sanitizedTableName}" SET ${updates} WHERE ${whereClause} RETURNING *`
    
    // Build the query with inline parameters to avoid sql.unsafe parameter issue
    const allValues = [...values, ...whereValues]
    let parameterizedQuery = query
    allValues.forEach((value, index) => {
      const placeholder = `$${index + 1}`
      const replacement = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value)
      parameterizedQuery = parameterizedQuery.replace(placeholder, replacement)
    })
    const result = await sql.unsafe(parameterizedQuery) as any

    return NextResponse.json({ 
      success: true, 
      row: Array.isArray(result) ? result[0] : result 
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error updating row:", error)
    return createInternalError("Failed to update row")
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const auth = await requireScopes(["write:tables"])
    if (!auth.success) {
      return auth.error
    }

    const { tableName } = await params
    
    // Sanitize table name to prevent SQL injection
    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '')
    if (sanitizedTableName !== tableName || !sanitizedTableName) {
      return NextResponse.json({ 
        error: "Invalid table name" 
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const { id } = await request.json()

    // Use inline parameter replacement for sql.unsafe
    const deleteQuery = `DELETE FROM "${sanitizedTableName}" WHERE id = '${String(id).replace(/'/g, "''")}'`
    await sql.unsafe(deleteQuery)

    return NextResponse.json({ 
      success: true 
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error deleting row:", error)
    return createInternalError("Failed to delete row")
  }
}
