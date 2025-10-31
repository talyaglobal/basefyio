import { createHash } from "crypto"

export interface PaginationParams {
  limit: number
  cursor?: string
  sortBy?: string
  sortOrder: "asc" | "desc"
}

export interface PaginationResult<T> {
  data: T[]
  nextCursor?: string
  hasMore: boolean
  totalCount?: number
}

export interface CursorData {
  value: any
  id: string
  timestamp: string
}

export function encodeCursor(data: CursorData): string {
  const jsonData = JSON.stringify(data)
  return Buffer.from(jsonData).toString("base64url")
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const jsonData = Buffer.from(cursor, "base64url").toString("utf-8")
    const data = JSON.parse(jsonData)
    
    // Validate cursor structure
    if (typeof data === "object" && data.value !== undefined && data.id && data.timestamp) {
      return data as CursorData
    }
    
    return null
  } catch (error) {
    console.error("Failed to decode cursor:", error)
    return null
  }
}

export function generateTimestampCursor(row: any, idField: string = "id"): string {
  return encodeCursor({
    value: row.created_at || row.timestamp || new Date().toISOString(),
    id: row[idField],
    timestamp: new Date().toISOString(),
  })
}

export function generateValueCursor(row: any, valueField: string, idField: string = "id"): string {
  return encodeCursor({
    value: row[valueField],
    id: row[idField],
    timestamp: new Date().toISOString(),
  })
}

export function buildCursorCondition(
  cursor: CursorData, 
  sortBy: string = "created_at",
  sortOrder: "asc" | "desc" = "desc",
  idField: string = "id"
): { condition: string; params: any[] } {
  const operator = sortOrder === "desc" ? "<" : ">"
  const equalOperator = sortOrder === "desc" ? "<=" : ">="
  
  if (sortBy === "created_at" || sortBy === "timestamp") {
    return {
      condition: `(${sortBy} ${operator} $1 OR (${sortBy} = $1 AND ${idField} ${operator} $2))`,
      params: [cursor.value, cursor.id],
    }
  }
  
  return {
    condition: `(${sortBy} ${operator} $1 OR (${sortBy} = $1 AND ${idField} ${operator} $2))`,
    params: [cursor.value, cursor.id],
  }
}

export interface OffsetPaginationParams {
  limit: number
  offset: number
  sortBy?: string
  sortOrder: "asc" | "desc"
}

export interface OffsetPaginationResult<T> {
  data: T[]
  totalCount: number
  hasMore: boolean
  currentPage: number
  totalPages: number
  limit: number
  offset: number
}

export function calculateOffsetPagination<T>(
  data: T[],
  params: OffsetPaginationParams,
  totalCount: number
): OffsetPaginationResult<T> {
  const currentPage = Math.floor(params.offset / params.limit) + 1
  const totalPages = Math.ceil(totalCount / params.limit)
  const hasMore = params.offset + params.limit < totalCount

  return {
    data,
    totalCount,
    hasMore,
    currentPage,
    totalPages,
    limit: params.limit,
    offset: params.offset,
  }
}

export class PaginationBuilder {
  private db: any // Can be SafeDatabase or Neon SQL
  private table: string
  private baseQuery: string
  private whereConditions: string[] = []
  private params: any[] = []
  private paramCount = 0

  constructor(db: any, table: string, baseQuery?: string) {
    this.db = db
    this.table = table
    this.baseQuery = baseQuery || `SELECT * FROM ${table}`
  }

  where(condition: string, ...params: any[]): this {
    this.whereConditions.push(condition)
    this.params.push(...params)
    return this
  }

  async paginate(
    paginationParams: PaginationParams,
    idField: string = "id"
  ): Promise<PaginationResult<any>> {
    const { limit, cursor, sortBy = "created_at", sortOrder = "desc" } = paginationParams

    let query = this.baseQuery
    let queryParams = [...this.params]

    // Add WHERE conditions
    if (this.whereConditions.length > 0 || cursor) {
      const conditions = [...this.whereConditions]
      
      if (cursor) {
        const cursorData = decodeCursor(cursor)
        if (cursorData) {
          const { condition, params } = buildCursorCondition(
            cursorData,
            sortBy,
            sortOrder,
            idField
          )
          conditions.push(condition)
          queryParams.push(...params)
        }
      }
      
      query += ` WHERE ${conditions.join(" AND ")}`
    }

    // Add ORDER BY
    query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}, ${idField} ${sortOrder.toUpperCase()}`

    // Add LIMIT (request one extra to check if there are more results)
    query += ` LIMIT ${limit + 1}`

    // Execute query - handle both SafeDatabase and regular Neon SQL
    let results: any[]
    if (this.db.safeSelect) {
      // SafeDatabase instance
      const result = await this.db.safeSelect(query, queryParams)
      results = result.rows
    } else {
      // Regular Neon SQL instance
      results = await this.db.unsafe(query, queryParams)
    }
    
    const hasMore = results.length > limit
    const data = hasMore ? results.slice(0, limit) : results
    
    let nextCursor: string | undefined
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1]
      nextCursor = generateValueCursor(lastItem, sortBy, idField)
    }

    return {
      data,
      nextCursor,
      hasMore,
    }
  }

  async count(): Promise<number> {
    let query = `SELECT COUNT(*) as count FROM ${this.table}`
    
    if (this.whereConditions.length > 0) {
      query += ` WHERE ${this.whereConditions.join(" AND ")}`
    }
    
    // Execute count query
    let result: any
    if (this.db.safeSelect) {
      // SafeDatabase instance
      const queryResult = await this.db.safeSelect(query, this.params)
      result = queryResult.rows[0]
    } else {
      // Regular Neon SQL instance
      const results = await this.db.unsafe(query, this.params)
      result = results[0]
    }
    
    return parseInt(result.count, 10)
  }
}