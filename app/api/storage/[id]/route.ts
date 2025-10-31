import { NextRequest, NextResponse } from "next/server"
import { requireScopes, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopes(["write:storage"])
    if (!auth.success) {
      return auth.error
    }

    const { id } = await params

    // Verify file belongs to user before deleting
    const checkResult = await safeDb.safeSelect(`
      SELECT id FROM storage_files 
      WHERE id = $1 AND uploaded_by = $2
    `, [id, auth.user.id])

    if (checkResult.rows.length === 0) {
      return NextResponse.json({
        code: "NOT_FOUND",
        message: "File not found or access denied"
      }, { 
        status: 404,
        headers: securityHeaders()
      })
    }

    // Delete the file using safe query
    await safeDb.safeUpdate(
      `DELETE FROM storage_files WHERE id = $1 AND uploaded_by = $2`,
      [id, auth.user.id],
      { allowDML: true }
    )

    return NextResponse.json({ 
      success: true,
      message: "File deleted successfully"
    }, {
      headers: securityHeaders()
    })
  } catch (error: any) {
    console.error("Error deleting file:", error)
    return createInternalError("Failed to delete file")
  }
}


