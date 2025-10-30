import type { Table, Column, RLSPolicy, FileObject, Bucket, APIKey, Organization, Project, User } from "@/types"

export const mockUser: User = {
  id: "1",
  email: "demo@kolaybase.dev",
  name: "Demo User",
  created_at: "2024-01-01T00:00:00Z",
}

export const mockOrganizations: Organization[] = [
  {
    id: "1",
    name: "Acme Corp",
    slug: "acme-corp",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "2",
    name: "Personal",
    slug: "personal",
    created_at: "2024-01-01T00:00:00Z",
  },
]

export const mockProjects: Project[] = [
  {
    id: "1",
    name: "Production",
    org_id: "1",
    database_url: "postgresql://localhost:5432/prod",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "2",
    name: "Staging",
    org_id: "1",
    database_url: "postgresql://localhost:5432/staging",
    created_at: "2024-01-15T00:00:00Z",
  },
]

export const mockTables: Table[] = [
  { schema: "public", name: "users", row_count: 1250, size: "2.4 MB" },
  { schema: "public", name: "organizations", row_count: 45, size: "128 KB" },
  { schema: "public", name: "memberships", row_count: 890, size: "512 KB" },
  { schema: "public", name: "notes", row_count: 5420, size: "8.2 MB" },
  { schema: "auth", name: "sessions", row_count: 3200, size: "1.8 MB" },
  { schema: "storage", name: "objects", row_count: 12500, size: "45 MB" },
]

export const mockColumns: Record<string, Column[]> = {
  users: [
    { name: "id", type: "uuid", nullable: false, is_primary_key: true, default_value: "gen_random_uuid()" },
    { name: "email", type: "text", nullable: false, is_primary_key: false },
    { name: "name", type: "text", nullable: true, is_primary_key: false },
    { name: "avatar", type: "text", nullable: true, is_primary_key: false },
    { name: "created_at", type: "timestamptz", nullable: false, is_primary_key: false, default_value: "now()" },
  ],
  organizations: [
    { name: "id", type: "uuid", nullable: false, is_primary_key: true, default_value: "gen_random_uuid()" },
    { name: "name", type: "text", nullable: false, is_primary_key: false },
    { name: "slug", type: "text", nullable: false, is_primary_key: false },
    { name: "created_at", type: "timestamptz", nullable: false, is_primary_key: false, default_value: "now()" },
  ],
}

export const mockPolicies: RLSPolicy[] = [
  {
    id: "1",
    table_name: "users",
    name: "Users can view their own data",
    command: "SELECT",
    definition: "id = current_user_id()",
    enabled: true,
  },
  {
    id: "2",
    table_name: "organizations",
    name: "Organization members can view",
    command: "SELECT",
    definition: "id IN (SELECT org_id FROM memberships WHERE user_id = current_user_id())",
    enabled: true,
  },
  {
    id: "3",
    table_name: "notes",
    name: "Users can manage their notes",
    command: "ALL",
    definition: "user_id = current_user_id()",
    enabled: true,
  },
]

export const mockBuckets: Bucket[] = [
  {
    id: "1",
    name: "avatars",
    public: true,
    file_size_limit: 5242880, // 5MB
    allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
  },
  {
    id: "2",
    name: "documents",
    public: false,
    file_size_limit: 52428800, // 50MB
  },
]

export const mockFiles: FileObject[] = [
  {
    id: "1",
    name: "profile-pics",
    type: "folder",
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "2",
    name: "user-123.jpg",
    type: "file",
    size: 245678,
    created_at: "2024-01-15T10:30:00Z",
    updated_at: "2024-01-15T10:30:00Z",
    metadata: { mimetype: "image/jpeg" },
  },
  {
    id: "3",
    name: "document.pdf",
    type: "file",
    size: 1245678,
    created_at: "2024-02-01T14:20:00Z",
    updated_at: "2024-02-01T14:20:00Z",
    metadata: { mimetype: "application/pdf" },
  },
]

export const mockAPIKeys: APIKey[] = [
  {
    id: "1",
    name: "Anon Key",
    key: "kb_anon_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    type: "anon",
    created_at: "2024-01-01T00:00:00Z",
    last_used: "2024-03-15T08:45:00Z",
  },
  {
    id: "2",
    name: "Service Role Key",
    key: "kb_service_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    type: "service_role",
    created_at: "2024-01-01T00:00:00Z",
    last_used: "2024-03-14T22:15:00Z",
  },
]
