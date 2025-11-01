import { z } from "zod"

// Common schemas
export const paginationSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export const sortSchema = z.object({
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
})

// Auth schemas
export const signInSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
})

export const signUpSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required"),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
})

// Table schemas
export const createTableRowSchema = z.object({
  data: z.record(z.any()),
})

export const updateTableRowSchema = z.object({
  data: z.record(z.any()),
  where: z.record(z.any()).optional(),
})

export const tableQuerySchema = z.object({
  select: z.string().optional(),
  where: z.string().optional(),
  orderBy: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).optional(),
  offset: z.coerce.number().min(0).optional(),
})

// SQL schemas
export const sqlExecuteSchema = z.object({
  query: z.string().min(1, "Query is required"),
  params: z.array(z.any()).optional(),
  readOnly: z.boolean().default(false),
  database_id: z.string().optional(), // Optional database ID to target a specific database
})

export const saveSqlQuerySchema = z.object({
  name: z.string().min(1, "Query name is required"),
  query: z.string().min(1, "Query is required"),
  description: z.string().optional(),
})

// Storage schemas
export const storageUploadSchema = z.object({
  name: z.string().min(1, "File name is required"),
  type: z.string().min(1, "File type is required"),
  size: z.number().min(1, "File size must be greater than 0"),
})

export const storageQuerySchema = z.object({
  prefix: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

// API Key schemas
export const createApiKeySchema = z.object({
  name: z.string().min(1, "API key name is required"),
  scopes: z.array(z.string()).min(1, "At least one scope is required"),
  expiresAt: z.string().datetime().optional(),
})

export const updateApiKeySchema = z.object({
  name: z.string().min(1, "API key name is required").optional(),
  scopes: z.array(z.string()).min(1, "At least one scope is required").optional(),
})

// Webhook schemas
export const createWebhookSchema = z.object({
  url: z.string().url("Invalid webhook URL"),
  events: z.array(z.string()).min(1, "At least one event type is required"),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
})

export const updateWebhookSchema = z.object({
  url: z.string().url("Invalid webhook URL").optional(),
  events: z.array(z.string()).min(1, "At least one event type is required").optional(),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
  active: z.boolean().optional(),
})

// Migration schemas
export const createMigrationSchema = z.object({
  name: z.string().min(1, "Migration name is required"),
  up: z.string().min(1, "Up migration is required"),
  down: z.string().min(1, "Down migration is required"),
})

export const runMigrationSchema = z.object({
  direction: z.enum(["up", "down"]).default("up"),
  steps: z.coerce.number().min(1).optional(),
  dryRun: z.boolean().default(false),
})

// RLS schemas
export const createRlsSchema = z.object({
  table: z.string().min(1, "Table name is required"),
  name: z.string().min(1, "Policy name is required"),
  type: z.enum(["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"]),
  roles: z.array(z.string()).optional(),
  expression: z.string().min(1, "Policy expression is required"),
})

export const updateRlsSchema = z.object({
  name: z.string().min(1, "Policy name is required").optional(),
  type: z.enum(["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"]).optional(),
  roles: z.array(z.string()).optional(),
  expression: z.string().min(1, "Policy expression is required").optional(),
  enabled: z.boolean().optional(),
})