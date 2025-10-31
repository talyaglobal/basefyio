import { NextRequest, NextResponse } from "next/server"
import { requireScopes, validateSearchParams, createInternalError, securityHeaders } from "@/lib/api-utils"
import { paginationSchema, storageQuerySchema } from "@/lib/validation-schemas"
import { PaginationBuilder } from "@/lib/pagination-utils"
import { safeDb } from "@/lib/db-safety"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopes(["read:storage"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(
      searchParams, 
      storageQuerySchema.merge(paginationSchema)
    )
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor, prefix } = validation.data

    // Use safe database with the pagination builder
    const builder = new PaginationBuilder(
      safeDb,
      "storage_files",
      "SELECT id, name, size, type, url, created_at FROM storage_files"
    )

    builder.where("user_id = $1", auth.user.id)

    if (prefix) {
      builder.where("name ILIKE $2", `${prefix}%`)
    }

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: "created_at",
      sortOrder: "desc"
    })

    return NextResponse.json({
      files: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error fetching files:", error)
    return createInternalError("Failed to fetch files")
  }
}
