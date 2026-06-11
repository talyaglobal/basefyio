import { z } from 'zod';

export const ActorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  role: z.enum(['user', 'admin', 'system', 'external']).default('user'),
});

export const ObjectSchema = z.object({
  name: z.string(),
  table: z.string(), // maps to DataModel table name
  description: z.string().optional(),
});

export const ProcessSchema = z.object({
  name: z.string(),
  description: z.string(),
  actors: z.array(z.string()),   // actor names
  objects: z.array(z.string()),  // object names
});

export const MetricSchema = z.object({
  name: z.string(),
  formula: z.string().optional(),
  description: z.string().optional(),
});

export const BusinessModelSchema = z.object({
  actors: z.array(ActorSchema).default([]),
  objects: z.array(ObjectSchema).default([]),
  processes: z.array(ProcessSchema).default([]),
  metrics: z.array(MetricSchema).default([]),
  domain: z.string().optional(), // detected domain slug e.g. 'crm'
});

export type Actor = z.infer<typeof ActorSchema>;
export type BusinessObject = z.infer<typeof ObjectSchema>;
export type Process = z.infer<typeof ProcessSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type BusinessModel = z.infer<typeof BusinessModelSchema>;
