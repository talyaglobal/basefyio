export interface ResourceTypeCapability {
  type: string;
  description: string;
}

export interface ProviderCapability {
  name: string;
  displayName: string;
  regions: string[];
  resourceTypes: string[];
  supportedResources: ResourceTypeCapability[];
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsRollback: boolean;
  supportsDryRun: boolean;
}
