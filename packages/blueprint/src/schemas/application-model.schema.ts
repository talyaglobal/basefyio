import { z } from 'zod';

export const RoleSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.array(z.enum(['read', 'write', 'delete']))),
});

export const NavigationItemSchema = z.object({
  label: z.string(),
  table: z.string(),
  icon: z.string().optional(),
});

export const ApplicationModelSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  roles: z.array(RoleSchema).default([]),
  navigation: z.array(NavigationItemSchema).default([]),
  features: z.array(z.string()).default([]),
  aiGenerated: z.boolean().default(false),
  templateSlug: z.string().optional(),
});

export type Role = z.infer<typeof RoleSchema>;
export type NavigationItem = z.infer<typeof NavigationItemSchema>;
export type ApplicationModel = z.infer<typeof ApplicationModelSchema>;
