import { ApplicationModel, ApplicationModelSchema } from '../schemas/application-model.schema.js';
import { BusinessModel } from '../schemas/business-model.schema.js';

interface DomainTemplateDefaults {
  roles?: ApplicationModel['roles'];
  navigation?: ApplicationModel['navigation'];
  features?: string[];
}

/**
 * Derive an Application Model from a Business Model + optional template defaults.
 * Pure function — deterministic, no I/O, no randomness.
 */
export function deriveApplicationModel(
  businessModel: BusinessModel,
  templateDefaults: DomainTemplateDefaults = {},
  opts: { aiGenerated?: boolean; templateSlug?: string } = {},
): ApplicationModel {
  // Default navigation: one entry per business object
  const navigation = templateDefaults.navigation ??
    businessModel.objects.map((o) => ({ label: o.name, table: o.table }));

  // Default role: admin + user (can be overridden by template)
  const roles = templateDefaults.roles ?? [
    {
      name: 'admin',
      permissions: Object.fromEntries(
        businessModel.objects.map((o) => [o.table, ['read', 'write', 'delete'] as const]),
      ),
    },
    {
      name: 'user',
      permissions: Object.fromEntries(
        businessModel.objects.map((o) => [o.table, ['read'] as const]),
      ),
    },
  ];

  const appName = businessModel.domain
    ? `${businessModel.domain.charAt(0).toUpperCase()}${businessModel.domain.slice(1)} App`
    : 'App';

  return ApplicationModelSchema.parse({
    name: appName,
    roles,
    navigation,
    features: templateDefaults.features ?? [],
    aiGenerated: opts.aiGenerated ?? false,
    templateSlug: opts.templateSlug,
  });
}
