import { z } from 'zod';
import { DataModelSchema } from './data-model.schema.js';
import { ApplicationModelSchema } from './application-model.schema.js';
import { UIModelSchema } from './ui-model.schema.js';

export const BuildPackageSchema = z.object({
  packageVersion: z.literal(1),
  projectId: z.string().nullable(),
  tenantId: z.string().nullable(),
  blueprintId: z.string(),
  applicationVersionId: z.string(),
  dataModel: DataModelSchema,
  permissionsModel: z.record(z.string(), z.unknown()).default({}),
  applicationModel: ApplicationModelSchema,
  navigationModel: z.array(z.object({ label: z.string(), table: z.string(), icon: z.string().optional() })).default([]),
  formDefinitions: z.record(z.string(), z.unknown()).default({}),
  tableListViews: z.record(z.string(), z.unknown()).default({}),
  dashboardReportDefinitions: z.record(z.string(), z.unknown()).default({}),
  apiDefinitions: z.record(z.string(), z.unknown()).default({}),
  authRequirements: z.record(z.string(), z.unknown()).default({}),
  sampleRecords: z.record(z.string(), z.array(z.unknown())).default({}),
  aiProvenance: z.record(z.string(), z.unknown()).default({}),
  designHints: z.record(z.string(), z.unknown()).default({}),
  uiModel: UIModelSchema,
  generatedAppIntent: z.string().default(''),
});

export type BuildPackage = z.infer<typeof BuildPackageSchema>;
