import { z } from 'zod';

export const FieldSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json', 'uuid', 'text']),
  nullable: z.boolean().default(true),
  unique: z.boolean().default(false),
  primaryKey: z.boolean().default(false),
  foreignKey: z.string().optional(), // references table name
  description: z.string().optional(),
});

export const TableSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  fields: z.array(FieldSchema),
  description: z.string().optional(),
  sourceSheet: z.string().optional(), // original Excel sheet name
});

export const DataModelSchema = z.object({
  tables: z.array(TableSchema),
  version: z.number().int().default(1),
});

export type Field = z.infer<typeof FieldSchema>;
export type Table = z.infer<typeof TableSchema>;
export type DataModel = z.infer<typeof DataModelSchema>;
