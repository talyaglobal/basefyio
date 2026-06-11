import { z } from 'zod';

export const PageTypeSchema = z.enum([
  'list', 'detail', 'form', 'dashboard', 'kanban', 'calendar', 'chart',
]);

export const PageSchema = z.object({
  type: PageTypeSchema,
  table: z.string().optional(),
  label: z.string().optional(),
  search: z.boolean().optional(),
  related: z.array(z.string()).optional(),
  groupBy: z.string().optional(),
  dateField: z.string().optional(),
  kind: z.string().optional(),    // for chart: 'line', 'bar', etc.
  x: z.string().optional(),
  y: z.string().optional(),
  widgets: z.array(z.string()).optional(),
});

export const UIModelSchema = z.object({
  pages: z.array(PageSchema),
  version: z.number().int().default(1),
});

export type Page = z.infer<typeof PageSchema>;
export type UIModel = z.infer<typeof UIModelSchema>;
