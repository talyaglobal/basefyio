import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    // In a real implementation, you would upload to a storage service like Vercel Blob
    // For now, we'll just store metadata
    const fileData = {
      name: file.name,
      size: file.size,
      type: file.type,
      url: `/uploads/${file.name}`, // Placeholder URL
    }

    const result = await sql`
      INSERT INTO storage_files (user_id, name, size, type, url)
      VALUES (${user.id}, ${fileData.name}, ${fileData.size}, ${fileData.type}, ${fileData.url})
      RETURNING id, name, size, type, url, created_at
    `

    return NextResponse.json({ success: true, file: result[0] })
  } catch (error) {
    console.error("Error uploading file:", error)
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 })
  }
}
