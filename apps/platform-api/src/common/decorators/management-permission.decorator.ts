import { SetMetadata } from '@nestjs/common';

export const MANAGEMENT_PERMISSION_KEY = 'management_permission';

export type ManagementPermission =
  | 'canAccessManagement'
  | 'canManageUsers'
  | 'canManageTeams'
  | 'canManagePlans'
  | 'canManageUserPackages'
  | 'canModerateFeedback'
  | 'canViewAuditLogs'
  | 'canViewRootAlerts';

export const RequireManagementPermission = (permission: ManagementPermission) =>
  SetMetadata(MANAGEMENT_PERMISSION_KEY, permission);
