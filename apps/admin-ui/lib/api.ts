import { getAccessToken, getRefreshToken, setTokens } from './auth';
import type {
  AuthTokens,
  ColumnInfo,
  ConnectionStrings,
  GitHubBranch,
  GitHubCommit,
  GitHubIntegration,
  GitHubRepo,
  ForeignKeyInfo,
  ExportJobProgressEvent,
  ExportJobResult,
  ImportJobProgressEvent,
  PendingInvite,
  Project,
  ProjectActivityItem,
  ProjectArchiveImportResponse,
  CloudBackupItem,
  ProjectAuthConfig,
  ProjectExportJobResponse,
  ProjectExportRequest,
  ProjectListItem,
  RealmInfo,
  RealmUser,
  SqlResult,
  StorageBucket,
  StorageObject,
  SupabaseImportRequest,
  SupabaseImportJobResponse,
  SupabaseValidateResult,
  TableInfo,
  TableRows,
  DataImportInspectResult,
  DataImportPlan,
  DataImportProgress,
  DataImportResult,
  DataImportJobStatus,
  Team,
  TeamGitHubStatus,
  TeamInvite,
  TeamMember,
  TeamVercelStatus,
  UserInfo,
  ManagementTeam,
  ManagementUser,
  ManagementUsersPageResponse,
  ManagementPlan,
  ManagementUserPackage,
  ManagementSearchConsoleSummary,
  ManagementAnalyticsTrafficSummary,
  RolePermissionMatrix,
  UserProfile,
  RootAlert,
  AuditLogEntry,
  ProjectDeletionReasonEntry,
  VercelDeployment,
  VercelIntegration,
  VercelProject,
} from './types';

/** Parse JSON body regardless of Content-Type casing (some proxies send Application/JSON). */
async function parseOkJsonBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return undefined as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined as T;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken();

  const res = await fetch(`/api/proxy${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    const authBody = await res
      .clone()
      .json()
      .catch(() => ({} as { message?: string; code?: string }));

    if (path === '/auth/login') {
      const err = new Error(authBody.message || authBody.code || 'Unauthorized') as Error & {
        code?: string;
        status?: number;
      };
      err.code = authBody.code || authBody.message || 'Unauthorized';
      err.status = 401;
      throw err;
    }

    // Some auth-protected endpoints can return business 401 errors (e.g. wrong current password).
    // In those cases, do not try refresh flow; surface the actual backend message.
    if (path === '/auth/change-password') {
      const err = new Error(authBody.message || 'Unauthorized') as Error & {
        code?: string;
        status?: number;
      };
      err.code = authBody.code || authBody.message || 'Unauthorized';
      err.status = 401;
      throw err;
    }

    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch('/api/proxy/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshRes.ok) {
          const tokens: AuthTokens = await parseOkJsonBody<AuthTokens>(refreshRes);
          setTokens(tokens);
          const retry = await fetch(`/api/proxy${path}`, {
            ...options,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tokens.accessToken}`,
              ...options.headers,
            },
          });
          if (retry.ok) return parseOkJsonBody<T>(retry);
        }
        // Refresh endpoint reached but rejected the credentials.
        //
        // By design we DO NOT auto-logout here. The user explicitly asked
        // to stay logged in until they manually press Logout. Surface a
        // typed error so callers can decide whether to show a banner or
        // re-prompt, but keep both tokens in localStorage so the user can
        // refresh the page and try the request again. If their refresh
        // token really is invalid, they'll see auth errors on subsequent
        // requests too — that's their cue to log out manually.
        if (refreshRes.status === 400 || refreshRes.status === 401) {
          throw new Error('Session refresh rejected. Please log out and back in if errors persist.');
        }
        // Transient server-side refresh failures should not force logout.
        throw new Error('Session refresh temporarily unavailable. Please retry.');
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg.includes('Session expired')) {
          throw err;
        }
      }
      // Network/proxy intermittent issues should not immediately log user out.
      throw new Error('Connection issue while refreshing session. Please retry.');
    }
    // No refresh token at all — user state is genuinely empty. Don't auto-
    // redirect; just throw so the caller surfaces the error. The user can
    // navigate to /login themselves if they want to.
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const errText = await res.text();
    let body: { message?: string; code?: string } = {};
    if (errText.trim()) {
      try {
        body = JSON.parse(errText) as { message?: string; code?: string };
      } catch {
        body = { message: errText.slice(0, 200) };
      }
    }
    const err = new Error(body.message || `Request failed: ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = body.code || body.message;
    err.status = res.status;
    throw err;
  }

  return parseOkJsonBody<T>(res);
}

export const api = {
  auth: {
    signup(data: { email: string; password: string; firstName?: string; lastName?: string; planName?: string }) {
      return request<{ message: string }>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    verifySignupOtp(email: string, otp: string) {
      return request<AuthTokens>('/auth/signup/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email, otp }),
      });
    },
    resendSignupOtp(email: string) {
      return request<{ message: string }>('/auth/signup/resend-otp', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
    login(email: string, password: string, captchaAnswer?: string) {
      return request<AuthTokens>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, captchaAnswer }),
      });
    },
    getCaptcha(email: string) {
      return request<{ required: boolean; question?: string; expiresInSeconds?: number }>(
        `/auth/captcha?email=${encodeURIComponent(email)}`,
      );
    },
    me() {
      return request<UserInfo>('/auth/me');
    },
    forgotPassword(email: string) {
      return request<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
    resetPassword(token: string, password: string) {
      return request<{ message: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
    },
    verifyResetToken(token: string) {
      return request<{ valid: boolean }>('/auth/reset-password/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },
    getProfile() {
      return request<UserProfile>('/auth/profile');
    },
    updateProfile(data: {
      firstName?: string;
      lastName?: string;
      email?: string;
      githubUsername?: string;
      avatarUrl?: string;
      notifySignIn?: boolean;
      notifySignInNewDevice?: boolean;
      notifyTeamInvite?: boolean;
      notifyBrowserPush?: boolean;
      allowIdentityEdit?: boolean;
    }) {
      return request<UserProfile>('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    changePassword(
      newPassword: string,
      allowIdentityEdit = false,
    ) {
      return request<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword, allowIdentityEdit }),
      });
    },
    completeForcedPasswordChange(newPassword: string) {
      return request<{ message: string }>('/auth/complete-forced-password-change', {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
    },
    async uploadAvatar(file: File): Promise<{ avatarUrl: string }> {
      const token = getAccessToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/proxy/auth/avatar', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).message || `Upload failed: ${res.status}`);
      }
      return res.json();
    },
    logout(
      refreshToken: string,
      postLogoutRedirectUri?: string,
      idToken?: string,
    ) {
      return request<{ message: string; logoutUrl?: string }>('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken, postLogoutRedirectUri, idToken }),
      });
    },
    getOAuthProviders() {
      return request<{ providers: string[] }>('/auth/oauth/providers');
    },
    getOAuthRedirect(provider: string, redirectTo?: string) {
      const qs = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      return request<{ url: string; provider: string }>(`/auth/oauth/${provider}${qs}`);
    },
    getCliStatePort(state: string) {
      return request<{ port: number }>(`/auth/cli-state?state=${encodeURIComponent(state)}`);
    },
    cliAuthorize(state: string, refreshToken: string) {
      return request<{ exchangeCode: string; port: number }>('/auth/cli-authorize', {
        method: 'POST',
        body: JSON.stringify({ state, refreshToken }),
      });
    },
    managementUsers(params?: { page?: number; pageSize?: number; q?: string }) {
      const sp = new URLSearchParams();
      if (params?.page != null && params.page > 0) {
        sp.set('page', String(Math.floor(params.page)));
      }
      if (params?.pageSize != null && params.pageSize > 0) {
        sp.set('pageSize', String(Math.floor(params.pageSize)));
      }
      if (params?.q?.trim()) {
        sp.set('q', params.q.trim());
      }
      const qs = sp.toString();
      return request<ManagementUsersPageResponse>(
        `/auth/management/users${qs ? `?${qs}` : ''}`,
      );
    },
    updateManagementUserRole(userId: string, role: 'USER' | 'ADMIN' | 'ROOT') {
      return request<{ id: string; email: string; role: 'USER' | 'ADMIN' | 'ROOT' }>(
        `/auth/management/users/${userId}/role`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        },
      );
    },
    updateManagementUserActive(userId: string, isActive: boolean) {
      return request<{ id: string; email: string; isActive: boolean }>(
        `/auth/management/users/${userId}/active`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive }),
        },
      );
    },
    updateManagementUserSignInMethod(
      userId: string,
      method: 'local' | 'google' | 'github',
    ) {
      return request<{ id: string; email: string; authProvider: 'local' | 'google' | 'github' }>(
        `/auth/management/users/${userId}/sign-in-method`,
        {
          method: 'PATCH',
          body: JSON.stringify({ method }),
        },
      );
    },
    resetManagementUserPassword(
      userId: string,
      data: { newPassword: string; forceChangeOnFirstLogin: boolean },
    ) {
      return request<{ id: string; email: string; forceChangeOnFirstLogin: boolean }>(
        `/auth/management/users/${userId}/reset-password`,
        {
          method: 'POST',
          body: JSON.stringify(data),
        },
      );
    },
    managementTeams() {
      return request<ManagementTeam[]>('/auth/management/teams');
    },
    deleteManagementTeam(teamId: string) {
      return request<{ id: string; name: string; deleted: true }>(
        `/auth/management/teams/${teamId}`,
        {
          method: 'DELETE',
        },
      );
    },
    managementRolePermissions() {
      return request<RolePermissionMatrix[]>('/auth/management/role-permissions');
    },
    managementMyPermissions() {
      return request<RolePermissionMatrix>('/auth/management/my-permissions');
    },
    updateManagementRolePermissions(
      role: 'USER' | 'ADMIN' | 'ROOT',
      patch: Partial<Omit<RolePermissionMatrix, 'role'>>,
    ) {
      return request<RolePermissionMatrix>(
        `/auth/management/role-permissions/${role}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      );
    },
    managementSearchConsole() {
      return request<ManagementSearchConsoleSummary>('/auth/management/marketing/search-console');
    },
    managementAnalyticsTraffic() {
      return request<ManagementAnalyticsTrafficSummary>('/auth/management/marketing/analytics/traffic');
    },
  },

  teams: {
    list() {
      return request<Team[]>('/teams');
    },
    create(name: string) {
      return request<Team>('/teams', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },
    getActive() {
      return request<{ teamId: string }>('/teams/active');
    },
    setActive(teamId: string) {
      return request<{ teamId: string }>('/teams/active', {
        method: 'PUT',
        body: JSON.stringify({ teamId }),
      });
    },
    deleteTeam(teamId: string) {
      return request<{ id: string; name: string; deleted: true }>(`/teams/${teamId}`, {
        method: 'DELETE',
      });
    },
    updateTeam(teamId: string, name: string) {
      return request<{ id: string; name: string }>(`/teams/${teamId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    },
    listMembers(teamId: string) {
      return request<TeamMember[]>(`/teams/${teamId}/members`);
    },
    removeMember(teamId: string, userId: string) {
      return request<{ message: string }>(`/teams/${teamId}/members/${userId}`, {
        method: 'DELETE',
      });
    },
    updateMemberRole(teamId: string, userId: string, role: 'ADMIN' | 'MEMBER') {
      return request<{ message: string }>(`/teams/${teamId}/members/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    },
    getRolePermissions(teamId: string) {
      return request<Record<string, { canRenameTeam: boolean; canInviteMembers: boolean; canRemoveMembers: boolean; canManageIntegrations: boolean }>>(`/teams/${teamId}/role-permissions`);
    },
    updateRolePermissions(teamId: string, role: 'ADMIN' | 'MEMBER', permissions: Record<string, boolean>) {
      return request<Record<string, boolean>>(`/teams/${teamId}/role-permissions/${role}`, {
        method: 'PUT',
        body: JSON.stringify(permissions),
      });
    },
    transferOwnership(teamId: string, newOwnerUserId: string) {
      return request<{ message: string }>(`/teams/${teamId}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ userId: newOwnerUserId }),
      });
    },
    sendInvite(teamId: string, usernameOrEmail: string) {
      return request<{ message: string }>(`/teams/${teamId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail }),
      });
    },
    listTeamInvites(teamId: string) {
      return request<PendingInvite[]>(`/teams/${teamId}/invites`);
    },
    cancelInvite(teamId: string, inviteId: string) {
      return request<{ message: string }>(`/teams/${teamId}/invites/${inviteId}`, {
        method: 'DELETE',
      });
    },
    reInvite(teamId: string, inviteId: string) {
      return request<{ message: string }>(`/teams/${teamId}/invites/${inviteId}/reinvite`, {
        method: 'POST',
      });
    },
    myInvites() {
      return request<TeamInvite[]>('/teams/invites');
    },
    acceptInvite(inviteId: string) {
      return request<{ message: string }>(`/teams/invites/${inviteId}/accept`, {
        method: 'POST',
      });
    },
    declineInvite(inviteId: string) {
      return request<{ message: string }>(`/teams/invites/${inviteId}/decline`, {
        method: 'POST',
      });
    },
  },

  projects: {
    list(teamId: string) {
      return request<ProjectListItem[]>(`/projects?teamId=${teamId}`);
    },
    get(id: string) {
      return request<Project>(`/projects/${id}`);
    },
    listActivity(id: string, opts: { page?: number; limit?: number } = {}) {
      const limit = opts.limit ?? 50;
      const page = opts.page ?? 1;
      return request<{
        items: ProjectActivityItem[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      }>(`/projects/${id}/activity?limit=${limit}&page=${page}`);
    },
    create(data: { name: string; description?: string; teamId: string }) {
      return request<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update(
      id: string,
      data: { folderId?: string | null; tags?: string[]; name?: string; description?: string | null },
    ) {
      return request<ProjectListItem>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete(
      id: string,
      data?: {
        reasonCode?: string;
        reasonLabel?: string;
        details?: string;
      },
    ) {
      return request<{ message: string }>(`/projects/${id}`, {
        method: 'DELETE',
        body: JSON.stringify(data ?? {}),
      });
    },
    listDeleted(teamId: string) {
      return request<ProjectListItem[]>(`/projects/deleted?teamId=${teamId}`);
    },
    listDeletionReasons(limit = 200) {
      return request<ProjectDeletionReasonEntry[]>(
        `/projects/deletion-reasons?limit=${limit}`,
      );
    },
    restore(id: string) {
      return request<{ message: string }>(`/projects/${id}/restore`, {
        method: 'POST',
      });
    },
    permanentDelete(id: string) {
      return request<{ message: string }>(`/projects/${id}/permanent`, {
        method: 'DELETE',
      });
    },
    moveToTeam(projectId: string, targetTeamId: string) {
      return request<{ message: string }>(`/projects/${projectId}/move-to-team`, {
        method: 'POST',
        body: JSON.stringify({ teamId: targetTeamId }),
      });
    },
    importFromSupabase(data: SupabaseImportRequest) {
      return request<SupabaseImportJobResponse>('/projects/import-supabase', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    async importFromExportZip(data: {
      file: File;
      teamId: string;
      nameMode: 'existing' | 'new';
      newProjectName?: string;
      existingProjectId?: string;
    }) {
      const token = getAccessToken();
      const form = new FormData();
      form.append('file', data.file);
      form.append('teamId', data.teamId);
      form.append('nameMode', data.nameMode);
      if (data.nameMode === 'new' && data.newProjectName?.trim()) {
        form.append('newProjectName', data.newProjectName.trim());
      }
      if (data.existingProjectId?.trim()) {
        form.append('existingProjectId', data.existingProjectId.trim());
      }

      const res = await fetch('/api/proxy/projects/import-export-zip', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `ZIP import failed: ${res.status}`);
      }
      return (await res.json()) as ProjectArchiveImportResponse;
    },
    validateSupabase(supabaseUrl: string, serviceRoleKey: string) {
      return request<SupabaseValidateResult>('/projects/import-supabase/validate', {
        method: 'POST',
        body: JSON.stringify({ supabaseUrl, serviceRoleKey }),
      });
    },
    getImportJobStatus(jobId: string) {
      return request<{
        id: string;
        state: string;
        progress: any;
        result?: any;
        failedReason?: string;
      }>(`/projects/import-supabase/jobs/${jobId}/status`);
    },
    cancelImport(jobId: string) {
      return request<{ message: string }>(`/projects/import-supabase/jobs/${jobId}/cancel`, {
        method: 'POST',
      });
    },
    startExport(projectId: string, options?: ProjectExportRequest) {
      return request<ProjectExportJobResponse>(`/projects/${projectId}/export`, {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      });
    },
    getExportStatus(projectId: string, jobId: string) {
      return request<{
        id: string;
        state: string;
        progress?: ExportJobProgressEvent;
        result?: ExportJobResult;
        failedReason?: string;
      }>(`/projects/${projectId}/export/jobs/${jobId}/status`);
    },
    streamExportProgress(
      projectId: string,
      jobId: string,
      callbacks: {
        onProgress: (data: ExportJobProgressEvent) => void;
        onCompleted: (data: ExportJobResult) => void;
        onFailed: (error: string) => void;
        onError?: (error: Event) => void;
        onState?: (state: string) => void;
      },
    ): EventSource {
      const token = getAccessToken();
      const url = `/api/proxy/projects/${projectId}/export/jobs/${jobId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const es = new EventSource(url);

      es.addEventListener('state', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onState?.(data.state);
        } catch {}
      });

      es.addEventListener('progress', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onProgress(data);
        } catch {}
      });

      es.addEventListener('completed', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onCompleted(data);
        } catch {
          callbacks.onFailed('Export completed, but response parsing failed');
        }
        es.close();
      });

      es.addEventListener('failed', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onFailed(data.error || 'Export failed');
        } catch {
          callbacks.onFailed('Export failed');
        }
        es.close();
      });

      es.addEventListener('error', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          if (data?.message) {
            callbacks.onFailed(data.message);
            es.close();
          }
        } catch {}
      });

      es.onerror = (e) => {
        callbacks.onError?.(e);
      };

      return es;
    },
    async downloadExport(projectId: string, jobId: string): Promise<{
      blob: Blob;
      filename: string;
    }> {
      const token = getAccessToken();
      const res = await fetch(
        `/api/proxy/projects/${projectId}/export/jobs/${jobId}/download`,
        {
          method: 'GET',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `Download failed: ${res.status}`);
      }

      const contentDisposition = res.headers.get('content-disposition') || '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] || `project-export-${projectId}.zip`;
      const blob = await res.blob();
      return { blob, filename };
    },
    listCloudBackups(projectId: string) {
      return request<CloudBackupItem[]>(`/projects/${projectId}/backups`);
    },
    restoreCloudBackup(
      projectId: string,
      data: {
        objectKey: string;
        teamId: string;
        nameMode: 'existing' | 'new';
        newProjectName?: string;
        existingProjectId?: string;
      },
    ) {
      return request<ProjectArchiveImportResponse>(`/projects/${projectId}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    streamImportProgress(
      jobId: string,
      callbacks: {
        onProgress: (data: ImportJobProgressEvent) => void;
        onCompleted: (data: any) => void;
        onFailed: (error: string) => void;
        onError?: (error: Event) => void;
        onState?: (state: string) => void;
      },
    ): EventSource {
      const token = getAccessToken();
      const url = `/api/proxy/projects/import-supabase/jobs/${jobId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

      const es = new EventSource(url);

      es.addEventListener('state', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onState?.(data.state);
        } catch {}
      });

      es.addEventListener('progress', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onProgress(data);
        } catch {}
      });

      es.addEventListener('completed', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onCompleted(data);
        } catch (err) {
          console.error('[SSE] Error handling completed event:', err);
        }
        es.close();
      });

      es.addEventListener('failed', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          callbacks.onFailed(data.error || 'Import failed');
        } catch {
          callbacks.onFailed('Import failed');
        }
        es.close();
      });

      es.addEventListener('error', (e) => {
        // Backend may emit a named "error" event with JSON payload.
        // If a message is present, treat it as a failed import.
        try {
          const data = JSON.parse((e as MessageEvent).data);
          if (data?.message) {
            callbacks.onFailed(data.message);
            es.close();
            return;
          }
        } catch {}
      });

      es.onerror = (e) => {
        callbacks.onError?.(e);
      };

      return es;
    },

    tables(projectId: string) {
      return request<TableInfo[]>(`/projects/${projectId}/tables`);
    },
    columns(projectId: string, tableName: string, schema?: string) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<ColumnInfo[]>(`/projects/${projectId}/tables/${tableName}/columns${qs}`);
    },
    rows(
      projectId: string,
      tableName: string,
      page = 1,
      limit = 50,
      schema?: string,
      search?: string,
      orderBy?: string,
      orderDir?: 'asc' | 'desc',
    ) {
      const schemaQs = schema ? `&schema=${encodeURIComponent(schema)}` : '';
      const searchQs = search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : '';
      const sortQs = orderBy
        ? `&orderBy=${encodeURIComponent(orderBy)}&orderDir=${orderDir === 'desc' ? 'desc' : 'asc'}`
        : '';
      return request<TableRows>(
        `/projects/${projectId}/tables/${tableName}/rows?page=${page}&limit=${limit}${schemaQs}${searchQs}${sortQs}`,
      );
    },
    createTable(projectId: string, data: {
      name: string;
      columns: { name: string; type: string; nullable: boolean; isPrimary: boolean; defaultValue?: string }[];
    }) {
      return request<{ message: string; sql: string }>(`/projects/${projectId}/tables`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    dropTable(projectId: string, tableName: string) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}`, {
        method: 'DELETE',
      });
    },
    /**
     * Remove duplicate rows. `keyColumns` defines what "duplicate" means —
     * two rows are duplicates when ALL key columns match (NULL = NULL).
     * `preview: true` runs a bounded COUNT (capped at 100k) without
     * deleting anything; `preview: false` actually deletes, batched
     * server-side. See backend service for ordering / FK handling notes.
     */
    deduplicateTableRows(
      projectId: string,
      tableName: string,
      body: { keyColumns: string[]; preview?: boolean },
      schema?: string,
    ) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<{
        preview: boolean;
        rowsToDelete?: number;
        previewCapped?: boolean;
        deleted?: number;
        partial?: boolean;
        batchesRun?: number;
      }>(`/projects/${projectId}/tables/${tableName}/deduplicate-rows${qs}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    insertRow(projectId: string, tableName: string, data: Record<string, unknown>, schema?: string) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<Record<string, unknown>>(`/projects/${projectId}/tables/${tableName}/rows${qs}`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    updateRow(projectId: string, tableName: string, pkWhere: Record<string, unknown>, data: Record<string, unknown>, schema?: string) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<Record<string, unknown>>(`/projects/${projectId}/tables/${tableName}/rows${qs}`, {
        method: 'PUT',
        body: JSON.stringify({ pkWhere, data }),
      });
    },
    deleteRow(projectId: string, tableName: string, pkWhere: Record<string, unknown>, schema?: string) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/rows${qs}`, {
        method: 'DELETE',
        body: JSON.stringify({ pkWhere }),
      });
    },
    addColumn(projectId: string, tableName: string, column: { name: string; type: string; nullable: boolean; defaultValue?: string; isUnique?: boolean }) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/columns`, {
        method: 'POST',
        body: JSON.stringify(column),
      });
    },
    editColumn(projectId: string, tableName: string, columnName: string, changes: { name?: string; type?: string; nullable?: boolean; defaultValue?: string | null; isUnique?: boolean }) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/columns/${columnName}`, {
        method: 'PUT',
        body: JSON.stringify(changes),
      });
    },
    deleteColumn(projectId: string, tableName: string, columnName: string) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/columns/${columnName}`, {
        method: 'DELETE',
      });
    },
    getForeignKeys(projectId: string, tableName: string) {
      return request<ForeignKeyInfo[]>(`/projects/${projectId}/tables/${tableName}/foreign-keys`);
    },
    addForeignKey(projectId: string, tableName: string, body: { columnName: string; foreignTableName: string; foreignColumnName: string }) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/foreign-keys`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    deleteForeignKey(projectId: string, tableName: string, constraintName: string) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/foreign-keys/${encodeURIComponent(constraintName)}`, {
        method: 'DELETE',
      });
    },
    connect(projectId: string) {
      return request<ConnectionStrings>(`/projects/${projectId}/connect`);
    },
    rotateDbPassword(projectId: string, password?: string) {
      return request<{ password: string }>(`/projects/${projectId}/db-password`, {
        method: 'PATCH',
        body: JSON.stringify(password ? { password } : {}),
      });
    },
    realmInfo(projectId: string) {
      return request<RealmInfo>(`/projects/${projectId}/auth`);
    },
    realmUsers(projectId: string) {
      return request<RealmUser[]>(`/projects/${projectId}/auth/users`);
    },
    createRealmUser(projectId: string, data: { email: string; password: string; firstName?: string; lastName?: string }) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    updateRealmUser(projectId: string, userId: string, data: { firstName?: string; lastName?: string; email?: string; enabled?: boolean }) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    resetRealmUserPassword(projectId: string, userId: string, newPassword: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
    },
    deleteRealmUser(projectId: string, userId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}`, {
        method: 'DELETE',
      });
    },
    getAuthConfig(projectId: string) {
      return request<ProjectAuthConfig>(`/projects/${projectId}/auth/config`);
    },
    updateAuthConfig(projectId: string, data: Partial<ProjectAuthConfig>) {
      return request<ProjectAuthConfig>(`/projects/${projectId}/auth/config`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    getProviders(projectId: string) {
      return request<{ callbackUrls: Record<string, string>; providers: any[] }>(
        `/projects/${projectId}/auth/providers`,
      );
    },
    saveProvider(projectId: string, provider: string, data: { clientId: string; clientSecret?: string; enabled: boolean }) {
      return request<ProjectAuthConfig>(`/projects/${projectId}/auth/providers/${provider}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /**
     * Generic CSV/XLSX → table import. Wizard flow:
     *   1. inspectDataImport(file)      — upload + preview + auto-detect schema
     *   2. startDataImport(plan)        — kicks off the background job
     *   3. streamDataImportEvents()     — SSE progress (preferred) OR
     *      getDataImportStatus()        — poll
     *   4. downloadDataImportErrors()   — URL for bad-rows CSV after completion
     */
    /**
     * Request a presigned PUT URL for direct-to-MinIO upload. Use this for
     * large files (>~50MB) that would otherwise hit reverse-proxy body limits
     * when going through the platform-api multipart endpoint.
     */
    presignDataImportUpload(projectId: string, filename: string) {
      return request<{ sourceKey: string; uploadUrl: string; expiresInSeconds: number }>(
        `/projects/${projectId}/data-imports/presign`,
        { method: 'POST', body: JSON.stringify({ filename }) },
      );
    },
    /**
     * Run inspect against a file already staged in MinIO via presigned upload.
     * Returns the same shape as inspectDataImport.
     */
    inspectStagedDataImport(
      projectId: string,
      args: { sourceKey: string; filename: string; firstRowIsHeader?: boolean },
    ) {
      return request<DataImportInspectResult>(
        `/projects/${projectId}/data-imports/inspect-staged`,
        { method: 'POST', body: JSON.stringify(args) },
      );
    },
    async inspectDataImport(
      projectId: string,
      file: File,
      opts: { firstRowIsHeader?: boolean } = {},
    ): Promise<DataImportInspectResult> {
      const token = getAccessToken();
      const fd = new FormData();
      fd.append('file', file);
      const qs =
        opts.firstRowIsHeader === false ? '?firstRowIsHeader=false' : '';
      const res = await fetch(`/api/proxy/projects/${projectId}/data-imports/inspect${qs}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `Import inspect failed: ${res.status}`);
      }
      return res.json();
    },
    startDataImport(projectId: string, plan: DataImportPlan) {
      return request<{ jobId: string }>(`/projects/${projectId}/data-imports/jobs`, {
        method: 'POST',
        body: JSON.stringify(plan),
      });
    },
    getDataImportStatus(projectId: string, jobId: string) {
      return request<DataImportJobStatus>(
        `/projects/${projectId}/data-imports/jobs/${jobId}/status`,
      );
    },
    streamDataImportEvents(
      projectId: string,
      jobId: string,
      callbacks: {
        onProgress: (data: DataImportProgress) => void;
        onCompleted: (data: DataImportResult) => void;
        onFailed: (error: string) => void;
        onState?: (state: string) => void;
        onError?: (event: Event) => void;
      },
    ): EventSource {
      const token = getAccessToken();
      const url = `/api/proxy/projects/${projectId}/data-imports/jobs/${jobId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const es = new EventSource(url);
      es.addEventListener('state', (e) => {
        try { callbacks.onState?.(JSON.parse((e as MessageEvent).data).state); } catch {}
      });
      es.addEventListener('progress', (e) => {
        try { callbacks.onProgress(JSON.parse((e as MessageEvent).data)); } catch {}
      });
      es.addEventListener('completed', (e) => {
        try { callbacks.onCompleted(JSON.parse((e as MessageEvent).data)); } catch {
          callbacks.onFailed('Import completed, response parse failed');
        }
        es.close();
      });
      es.addEventListener('failed', (e) => {
        try { callbacks.onFailed(JSON.parse((e as MessageEvent).data).error || 'Import failed'); } catch {
          callbacks.onFailed('Import failed');
        }
        es.close();
      });
      es.onerror = (e) => callbacks.onError?.(e);
      return es;
    },
    cancelDataImport(projectId: string, jobId: string) {
      return request<{ ok: boolean }>(
        `/projects/${projectId}/data-imports/jobs/${jobId}/cancel`,
        { method: 'POST' },
      );
    },
    /** URL for the bad-rows CSV; hand it to <a download>. */
    downloadDataImportErrors(projectId: string, jobId: string): string {
      return `/api/proxy/projects/${projectId}/data-imports/jobs/${jobId}/errors`;
    },
  },

  integrations: {
    getGitHub(projectId: string) {
      return request<GitHubIntegration>(`/projects/${projectId}/integrations/github`);
    },
    connectGitHub(projectId: string, data: { token?: string; owner: string; repo: string; branch?: string; useTeamToken?: boolean; teamId?: string }) {
      return request<GitHubIntegration>(`/projects/${projectId}/integrations/github`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    disconnectGitHub(projectId: string) {
      return request<{ connected: false }>(`/projects/${projectId}/integrations/github`, {
        method: 'DELETE',
      });
    },
    listGitHubRepos(projectId: string, token: string) {
      return request<GitHubRepo[]>(`/projects/${projectId}/integrations/github/repos?token=${encodeURIComponent(token)}`);
    },
    getGitHubCommits(projectId: string) {
      return request<GitHubCommit[]>(`/projects/${projectId}/integrations/github/commits`);
    },
    getGitHubBranches(projectId: string) {
      return request<GitHubBranch[]>(`/projects/${projectId}/integrations/github/branches`);
    },
    previewGitHubBranches(projectId: string, token: string, owner: string, repo: string) {
      return request<GitHubBranch[]>(
        `/projects/${projectId}/integrations/github/branches/preview?token=${encodeURIComponent(token)}&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      );
    },
    getVercel(projectId: string) {
      return request<VercelIntegration>(`/projects/${projectId}/integrations/vercel`);
    },
    connectVercel(projectId: string, data: { token?: string; projectId: string; teamId?: string; useTeamToken?: boolean; sourceTeamId?: string }) {
      return request<VercelIntegration>(`/projects/${projectId}/integrations/vercel`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    disconnectVercel(projectId: string) {
      return request<{ connected: false }>(`/projects/${projectId}/integrations/vercel`, {
        method: 'DELETE',
      });
    },
    listVercelProjects(projectId: string, token: string, teamId?: string) {
      const params = new URLSearchParams({ token });
      if (teamId) params.set('teamId', teamId);
      return request<VercelProject[]>(`/projects/${projectId}/integrations/vercel/projects?${params}`);
    },
    getVercelDeployments(projectId: string) {
      return request<VercelDeployment[]>(`/projects/${projectId}/integrations/vercel/deployments`);
    },
    syncVercelEnv(projectId: string) {
      return request<{ synced: boolean; created: number; updated: number; keys: string[] }>(
        `/projects/${projectId}/integrations/vercel/sync-env`,
        { method: 'POST' },
      );
    },
  },

  teamIntegrations: {
    getGitHubStatus(teamId: string) {
      return request<TeamGitHubStatus>(`/team-integrations/${teamId}/github/status`);
    },
    getGitHubConnectUrl(teamId: string) {
      return request<{ url: string }>(`/team-integrations/${teamId}/github/connect-url`);
    },
    connectGitHubWithPat(teamId: string, token: string) {
      return request<void>(`/team-integrations/${teamId}/github/connect-pat`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },
    disconnectGitHub(teamId: string) {
      return request<{ message: string }>(`/team-integrations/${teamId}/github`, {
        method: 'DELETE',
      });
    },
    listGitHubRepos(teamId: string) {
      return request<GitHubRepo[]>(`/team-integrations/${teamId}/github/repos`);
    },
    listGitHubBranches(teamId: string, owner: string, repo: string) {
      return request<GitHubBranch[]>(
        `/team-integrations/${teamId}/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      );
    },
    getVercelStatus(teamId: string) {
      return request<TeamVercelStatus>(`/team-integrations/${teamId}/vercel/status`);
    },
    getVercelConnectUrl(teamId: string) {
      return request<{ url: string }>(`/team-integrations/${teamId}/vercel/connect-url`);
    },
    connectVercelWithToken(teamId: string, token: string) {
      return request<void>(`/team-integrations/${teamId}/vercel/connect`, {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },
    disconnectVercel(teamId: string) {
      return request<{ message: string }>(`/team-integrations/${teamId}/vercel`, {
        method: 'DELETE',
      });
    },
    listVercelProjects(teamId: string) {
      return request<VercelProject[]>(`/team-integrations/${teamId}/vercel/projects`);
    },
  },

  sql: {
    execute(
      projectId: string,
      query: string,
      opts?: { page?: number; limit?: number; countTotal?: boolean },
    ) {
      return request<SqlResult>('/sql/execute', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          query,
          page: opts?.page,
          limit: opts?.limit,
          countTotal: opts?.countTotal,
        }),
      });
    },
  },

  feedback: {
    async uploadAttachment(file: File): Promise<{
      url: string;
      mimeType: string;
      kind: 'image' | 'video';
    }> {
      const token = getAccessToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/proxy/feedback/attachments', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { message?: string }).message || `Upload failed (${res.status})`);
      }
      return body as { url: string; mimeType: string; kind: 'image' | 'video' };
    },
    create(data: {
      url: string;
      title: string;
      description?: string;
      type?: string;
      attachments?: { url: string; mimeType: string; kind: 'image' | 'video' }[];
    }) {
      return request<{ id: string }>('/feedback', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    list() {
      return request<{
        id: string;
        userId: string;
        email: string;
        url: string;
        title: string;
        description: string | null;
        attachments?: unknown;
        comments?: {
          id: string;
          feedbackId: string;
          userId: string;
          user?: { email: string } | null;
          comment: string;
          attachments?: unknown;
          parentCommentId?: string | null;
          createdAt: string;
        }[];
        type: string;
        status: string;
        deletedAt?: string | null;
        createdAt: string;
      }[]>('/feedback');
    },
    updateStatus(id: string, status: string) {
      return request<{ id: string; status: string }>(`/feedback/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },
    update(id: string, data: { title?: string; description?: string }) {
      return request<{ id: string; title: string; description: string | null }>(`/feedback/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    remove(id: string) {
      return request<{ success: boolean }>(`/feedback/${id}`, {
        method: 'DELETE',
      });
    },
    listComments(id: string) {
      return request<{
        id: string;
        feedbackId: string;
        userId: string;
        user?: { email: string } | null;
        comment: string;
        attachments?: unknown;
        parentCommentId?: string | null;
        createdAt: string;
      }[]>(`/feedback/${id}/comments`);
    },
    addComment(id: string, data: { comment: string; attachments?: { url: string; mimeType: string; kind: 'image' | 'video' }[]; parentCommentId?: string }) {
      return request<{
        id: string;
        feedbackId: string;
        userId: string;
        user?: { email: string } | null;
        comment: string;
        attachments?: unknown;
        parentCommentId?: string | null;
        createdAt: string;
      }>(`/feedback/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    history(id: string) {
      return request<{
        id: string;
        feedbackId: string;
        userId: string;
        user?: { email: string } | null;
        action: string;
        detail?: string | null;
        createdAt: string;
      }[]>(`/feedback/${id}/history`);
    },
  },

  storage: {
    listBuckets(projectId: string) {
      return request<StorageBucket[]>(`/projects/${projectId}/storage/buckets`);
    },
    createBucket(projectId: string, name: string, isPublic = false) {
      return request<StorageBucket>(`/projects/${projectId}/storage/buckets`, {
        method: 'POST',
        body: JSON.stringify({ name, public: isPublic }),
      });
    },
    deleteBucket(projectId: string, bucketName: string) {
      return request<{ message: string }>(`/projects/${projectId}/storage/buckets/${bucketName}`, {
        method: 'DELETE',
      });
    },
    updateBucket(projectId: string, bucketName: string, isPublic: boolean) {
      return request<{ public: boolean }>(`/projects/${projectId}/storage/buckets/${bucketName}`, {
        method: 'PATCH',
        body: JSON.stringify({ public: isPublic }),
      });
    },
    listObjects(projectId: string, bucketName: string, prefix = '') {
      const p = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      return request<StorageObject[]>(`/projects/${projectId}/storage/buckets/${bucketName}/objects${p}`);
    },
    async upload(projectId: string, bucketName: string, path: string, file: File) {
      const token = getAccessToken();
      const form = new FormData();
      form.append('file', file);

      const res = await fetch(
        `/api/proxy/projects/${projectId}/storage/buckets/${bucketName}/objects?path=${encodeURIComponent(path)}`,
        {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Upload failed: ${res.status}`);
      }

      return res.json();
    },
    downloadUrl(projectId: string, bucketName: string, path: string) {
      return request<{ url: string; expiresIn: number }>(
        `/projects/${projectId}/storage/buckets/${bucketName}/objects/url?path=${encodeURIComponent(path)}`,
      );
    },
    deleteObjects(projectId: string, bucketName: string, paths: string[]) {
      return request<{ message: string }>(`/projects/${projectId}/storage/buckets/${bucketName}/objects`, {
        method: 'DELETE',
        body: JSON.stringify({ paths }),
      });
    },
  },

  folders: {
    list(teamId: string) {
      return request<import('./types').ProjectFolder[]>(`/project-folders?teamId=${teamId}`);
    },
    create(teamId: string, name: string, color?: string) {
      return request<import('./types').ProjectFolder>('/project-folders', {
        method: 'POST',
        body: JSON.stringify({ teamId, name, color }),
      });
    },
    update(id: string, data: { name?: string; color?: string }) {
      return request<import('./types').ProjectFolder>(`/project-folders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete(id: string) {
      return request<{ success: boolean }>(`/project-folders/${id}`, {
        method: 'DELETE',
      });
    },
  },

  ai: {
    chat(
      message: string,
      history: { role: 'user' | 'assistant'; content: string }[],
      context: {
        projectId?: string;
        projectName?: string;
        tables?: string[];
        page?: string;
        allProjects?: { id: string; name: string }[];
        mode?: 'ask' | 'plan' | 'agent';
      },
    ) {
      return request<{ reply: string }>('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message, history, context }),
      });
    },
  },

  billing: {
    plans(): Promise<any[]> {
      // Uses a dedicated cached route (5-min ISR) instead of the force-dynamic proxy
      return fetch('/api/billing-plans').then((r) => (r.ok ? r.json() : []));
    },
    subscription(teamId: string) {
      return request<any>(`/billing/subscription?teamId=${teamId}`);
    },
    usage(teamId: string) {
      return request<any>(`/billing/usage?teamId=${teamId}`);
    },
    invoices(teamId: string) {
      return request<any[]>(`/billing/invoices?teamId=${teamId}`);
    },
    createCheckout(teamId: string, planName: string) {
      const successUrl = `${window.location.origin}/dashboard/billing?success=true`;
      const cancelUrl = `${window.location.origin}/dashboard/billing?canceled=true`;
      return request<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ teamId, planName, successUrl, cancelUrl }),
      });
    },
    createPortal(teamId: string) {
      const returnUrl = `${window.location.origin}/dashboard/billing`;
      return request<{ url: string }>('/billing/portal', {
        method: 'POST',
        body: JSON.stringify({ teamId, returnUrl }),
      });
    },
    account(teamId: string) {
      return request<any>(`/billing/account?teamId=${teamId}`);
    },
    updateAccount(teamId: string, data: {
      companyName?: string;
      taxId?: string;
      vatNumber?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
      billingEmail?: string;
      phone?: string;
    }) {
      return request<any>('/billing/account', {
        method: 'POST',
        body: JSON.stringify({ teamId, ...data }),
      });
    },
    paymentMethod(teamId: string) {
      return request<{ brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null>(
        `/billing/payment-method?teamId=${teamId}`,
      );
    },
    createSetupIntent(teamId: string) {
      return request<{ clientSecret: string; customerId: string }>('/billing/setup-intent', {
        method: 'POST',
        body: JSON.stringify({ teamId }),
      });
    },
    attachPaymentMethod(teamId: string, paymentMethodId: string) {
      return request<{ success: boolean }>('/billing/attach-payment-method', {
        method: 'POST',
        body: JSON.stringify({ teamId, paymentMethodId }),
      });
    },
    cancelSubscription(teamId: string) {
      return request<{ message: string }>('/billing/cancel', {
        method: 'POST',
        body: JSON.stringify({ teamId }),
      });
    },
    resumeSubscription(teamId: string) {
      return request<{ message: string }>('/billing/resume', {
        method: 'POST',
        body: JSON.stringify({ teamId }),
      });
    },
    changePlan(teamId: string, planName: string) {
      return request<{ message: string }>('/billing/change-plan', {
        method: 'POST',
        body: JSON.stringify({ teamId, planName }),
      });
    },
    previewPlanChange(teamId: string, planName: string) {
      return request<{
        currentPlan: { name: string; displayName: string; priceMonthly: number };
        targetPlan: { name: string; displayName: string; priceMonthly: number };
        currency: string;
        dueNow: number;
        subtotal: number;
        total: number;
        prorationTotal: number;
        nextPaymentAttemptAt: string | null;
        currentPeriodEnd: string | null;
        firstChargeAt: string | null;
        firstChargeAmount: number;
        lines: Array<{
          description: string;
          amount: number;
          currency: string;
          proration: boolean;
          periodStart: string | null;
          periodEnd: string | null;
        }>;
      }>('/billing/preview-plan-change', {
        method: 'POST',
        body: JSON.stringify({ teamId, planName }),
      });
    },
    retryPayment(teamId: string, paymentMethodId?: string) {
      return request<{ message: string; success: boolean }>('/billing/retry-payment', {
        method: 'POST',
        body: JSON.stringify({ teamId, paymentMethodId }),
      });
    },
    managementPlans() {
      return request<ManagementPlan[]>('/billing/management/plans');
    },
    updateManagementPlan(
      planName: string,
      data: {
        displayName?: string;
        priceMonthly?: number;
        maxProjects?: number | null;
        maxStorageBytes?: string | null;
        maxTeamMembers?: number | null;
        maxDbSizeBytes?: string | null;
        maxApiRequests?: number | null;
        maxBandwidthBytes?: string | null;
        maxMau?: number | null;
        isPublic?: boolean;
      },
    ) {
      return request<ManagementPlan>(`/billing/management/plans/${encodeURIComponent(planName)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    createManagementPlan(data: {
      name: string;
      displayName: string;
      priceMonthly?: number;
      maxProjects?: number | null;
      maxStorageBytes?: string | null;
      maxTeamMembers?: number | null;
      maxDbSizeBytes?: string | null;
      maxApiRequests?: number | null;
      maxBandwidthBytes?: string | null;
      maxMau?: number | null;
      isPublic?: boolean;
    }) {
      return request<ManagementPlan>('/billing/management/plans', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteManagementPlan(planName: string, replacementPlanName = 'free') {
      const qs = `?replacementPlanName=${encodeURIComponent(replacementPlanName)}`;
      return request<{ deletedPlan: string; replacementPlan: string; migratedSubscriptions: number }>(
        `/billing/management/plans/${encodeURIComponent(planName)}${qs}`,
        { method: 'DELETE' },
      );
    },
    managementUserPackages() {
      return request<ManagementUserPackage[]>('/billing/management/user-packages');
    },
    managementUserPackagesForUsers(userIds: string[]) {
      if (!userIds.length) {
        return Promise.resolve([] as ManagementUserPackage[]);
      }
      const qs = `?userIds=${userIds.map((id) => encodeURIComponent(id)).join(',')}`;
      return request<ManagementUserPackage[]>(`/billing/management/user-packages${qs}`);
    },
    updateManagementUserPackage(userId: string, planName: string) {
      return request<{
        userId: string;
        teamId: string;
        teamName: string;
        planName: string;
        planDisplayName: string;
        planPriceMonthly: number;
      }>(`/billing/management/user-packages/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ planName }),
      });
    },
  },
  observability: {
    listRootAlerts(limit = 100) {
      return request<RootAlert[]>(`/observability/root-alerts?limit=${limit}`);
    },
    markRootAlertRead(id: string) {
      return request<RootAlert>(`/observability/root-alerts/${id}/read`, {
        method: 'PATCH',
      });
    },
    listAuditLogs(limit?: number) {
      const qs =
        limit != null && Number.isFinite(limit) && limit > 0
          ? `?limit=${Math.floor(limit)}`
          : '';
      return request<AuditLogEntry[]>(`/observability/audit-logs${qs}`);
    },
    getAuditLog(id: string) {
      return request<AuditLogEntry>(`/observability/audit-logs/${id}`);
    },
  },

  embeddings: {
    getStatus(projectId: string) {
      return request<{
        pgvectorEnabled: boolean;
        pgvectorEnabledAt: string | null;
        hasApiKey: boolean;
        embeddingCount: number | null;
      }>(`/projects/${projectId}/embeddings/status`);
    },
    enable(projectId: string) {
      return request<{ message: string; projectId: string }>(
        `/projects/${projectId}/embeddings/enable`,
        { method: 'POST' },
      );
    },
    disable(projectId: string) {
      return request<{ message: string; projectId: string }>(
        `/projects/${projectId}/embeddings/enable`,
        { method: 'DELETE' },
      );
    },
    setApiKey(projectId: string, apiKey: string | null) {
      return request<{ message: string }>(
        `/projects/${projectId}/embeddings/api-key`,
        { method: 'POST', body: JSON.stringify({ apiKey }) },
      );
    },
  },

  tags: {
    list(teamId: string) {
      return request<import('./types').ProjectTag[]>(`/project-tags?teamId=${teamId}`);
    },
    create(teamId: string, name: string, color?: string) {
      return request<import('./types').ProjectTag>('/project-tags', {
        method: 'POST',
        body: JSON.stringify({ teamId, name, color }),
      });
    },
    update(id: string, data: { name?: string; color?: string }) {
      return request<import('./types').ProjectTag>(`/project-tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete(id: string) {
      return request<{ success: boolean }>(`/project-tags/${id}`, {
        method: 'DELETE',
      });
    },
  },
};
