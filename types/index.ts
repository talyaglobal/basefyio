// Core Types
export interface User {
  id: string
  email: string
  name?: string
  avatar?: string
  created_at: string
}

export interface Organization {
  id: string
  name: string
  slug: string
  created_at: string
}

export interface Project {
  id: string
  name: string
  org_id: string
  database_url: string
  created_at: string
}

export interface AuthResponse {
  user: User
  token: string
  expires_at: string
}

// Database Types
export interface Table {
  schema: string
  name: string
  row_count: number
  size: string
}

export interface Column {
  name: string
  type: string
  nullable: boolean
  default_value?: string
  is_primary_key: boolean
}

export interface TableMetadata {
  table: Table
  columns: Column[]
}

// RLS Policy Types
export interface RLSPolicy {
  id: string
  table_name: string
  name: string
  command: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL"
  definition: string
  enabled: boolean
}

// Storage Types
export interface FileObject {
  name: string
  id: string
  size: number
  type: "file" | "folder"
  created_at: string
  updated_at: string
  metadata?: Record<string, any>
}

export interface Bucket {
  id: string
  name: string
  public: boolean
  file_size_limit?: number
  allowed_mime_types?: string[]
}

// Realtime Types
export interface RealtimeEvent {
  type: "INSERT" | "UPDATE" | "DELETE"
  table: string
  schema: string
  old_record?: Record<string, any>
  new_record?: Record<string, any>
  timestamp: string
}

// API Key Types
export interface APIKey {
  id: string
  name: string
  key: string
  type: "anon" | "service_role"
  created_at: string
  last_used?: string
}
