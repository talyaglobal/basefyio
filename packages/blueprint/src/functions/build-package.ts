import { BuildPackage, BuildPackageSchema } from '../schemas/build-package.schema.js';
import { DataModel } from '../schemas/data-model.schema.js';
import { ApplicationModel } from '../schemas/application-model.schema.js';
import { UIModel } from '../schemas/ui-model.schema.js';

interface BlueprintSnapshot {
  id: string;
  projectId: string | null;
  dataModel: DataModel;
  applicationModel: ApplicationModel;
  uiModel: UIModel;
  aiProvenance?: Record<string, unknown>;
}

interface VersionSnapshot {
  id: string;
  version: number;
}

/**
 * Emit a Nfyio Build Package from a Blueprint + ApplicationVersion snapshot.
 * Pure function — no I/O.
 */
export function buildPackage(
  blueprint: BlueprintSnapshot,
  version: VersionSnapshot,
): BuildPackage {
  return BuildPackageSchema.parse({
    packageVersion: 1,
    projectId: blueprint.projectId,
    tenantId: blueprint.projectId, // same until multi-tenancy splits
    blueprintId: blueprint.id,
    applicationVersionId: version.id,
    dataModel: blueprint.dataModel,
    applicationModel: blueprint.applicationModel,
    uiModel: blueprint.uiModel,
    navigationModel: blueprint.applicationModel.navigation,
    aiProvenance: blueprint.aiProvenance ?? {},
    generatedAppIntent: `App generated from blueprint ${blueprint.id}`,
  });
}
