import { UIModel, UIModelSchema } from '../schemas/ui-model.schema.js';
import { BuildPackage } from '../schemas/build-package.schema.js';

/**
 * Derive a UI Model from a Build Package.
 * Pure function — executed by Nfyio. Never hand-edit the output.
 */
export function deriveUIModel(pkg: BuildPackage): UIModel {
  const { dataModel, applicationModel } = pkg;

  const pages: UIModel['pages'] = [];

  // Dashboard page (always first)
  pages.push({
    type: 'dashboard',
    label: 'Dashboard',
    widgets: applicationModel.navigation
      .slice(0, 4)
      .map((n) => `count:${n.table}`),
  });

  // Per-table: list + form + detail
  for (const table of dataModel.tables) {
    pages.push({ type: 'list', table: table.name, label: table.displayName, search: true });
    pages.push({ type: 'form', table: table.name, label: `New ${table.displayName}` });
    pages.push({ type: 'detail', table: table.name, label: table.displayName });
  }

  return UIModelSchema.parse({ pages });
}
