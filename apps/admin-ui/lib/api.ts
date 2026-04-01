import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './auth';
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
  Team,
  TeamGitHubStatus,
  TeamInvite,
  TeamMember,
  TeamVercelStatus,
  UserInfo,
  UserProfile,
  VercelDeployment,
  VercelIntegration,
  VercelProject,
} from './types';

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
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch('/api/proxy/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshRes.ok) {
          const tokens: AuthTokens = await refreshRes.json();
          setTokens(tokens);
          const retry = await fetch(`/api/proxy${path}`, {
            ...options,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tokens.accessToken}`,
              ...options.headers,
            },
          });
          if (retry.ok) return retry.json();
        }
      } catch {}
    }
    clearTokens();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const contentLength = res.headers.get('content-length');
  if (res.status === 204 || contentLength === '0' || !contentType.includes('application/json')) {
    return undefined as T;
  }
  return res.json();
}

export const api = {
  auth: {
    signup(data: { email: string; password: string; firstName?: string; lastName?: string }) {
      return request<AuthTokens>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    login(email: string, password: string) {
      return request<AuthTokens>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
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
    getProfile() {
      return request<UserProfile>('/auth/profile');
    },
    updateProfile(data: {
      username?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      githubUsername?: string;
      avatarUrl?: string;
      notifySignIn?: boolean;
      notifyTeamInvite?: boolean;
    }) {
      return request<UserProfile>('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    changePassword(currentPassword: string, newPassword: string) {
      return request<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
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
    logout(refreshToken: string) {
      return request<{ message: string }>('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    },
    getOAuthProviders() {
      return request<{ providers: string[] }>('/auth/oauth/providers');
    },
    getOAuthRedirect(provider: string, redirectTo?: string) {
      const qs = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      return request<{ url: string; provider: string }>(`/auth/oauth/${provider}${qs}`);
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
    listActivity(id: string, limit = 100) {
      return request<{ items: ProjectActivityItem[] }>(
        `/projects/${id}/activity?limit=${limit}`,
      );
    },
    create(data: { name: string; description?: string; teamId: string }) {
      return request<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update(id: string, data: { folderId?: string | null; tags?: string[]; name?: string; description?: string }) {
      return request<ProjectListItem>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete(id: string) {
      return request<{ message: string }>(`/projects/${id}`, {
        method: 'DELETE',
      });
    },
    listDeleted(teamId: string) {
      return request<ProjectListItem[]>(`/projects/deleted?teamId=${teamId}`);
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
    validateSupabase(supabaseUrl: string, serviceRoleKey: string) {
      return request<SupabaseValidateResult>('/projects/import-supabase/validate', {
        method: 'POST',
        body: JSON.stringify({ supabaseUrl, serviceRoleKey }),
      });
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
        // EventSource native error - not a named event from backend
      });

      es.onerror = (e) => {
        callbacks.onError?.(e);
      };

      return es;
    },

    tables(projectId: string) {
      return request<TableInfo[]>(`/projects/${projectId}/tables`);
    },
    columns(projectId: string, tableName: string) {
      return request<ColumnInfo[]>(`/projects/${projectId}/tables/${tableName}/columns`);
    },
    rows(projectId: string, tableName: string, page = 1, limit = 50) {
      return request<TableRows>(`/projects/${projectId}/tables/${tableName}/rows?page=${page}&limit=${limit}`);
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
    insertRow(projectId: string, tableName: string, data: Record<string, unknown>) {
      return request<Record<string, unknown>>(`/projects/${projectId}/tables/${tableName}/rows`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    updateRow(projectId: string, tableName: string, pkWhere: Record<string, unknown>, data: Record<string, unknown>) {
      return request<Record<string, unknown>>(`/projects/${projectId}/tables/${tableName}/rows`, {
        method: 'PUT',
        body: JSON.stringify({ pkWhere, data }),
      });
    },
    deleteRow(projectId: string, tableName: string, pkWhere: Record<string, unknown>) {
      return request<{ message: string }>(`/projects/${projectId}/tables/${tableName}/rows`, {
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
    execute(projectId: string, query: string) {
      return request<SqlResult>('/sql/execute', {
        method: 'POST',
        body: JSON.stringify({ projectId, query }),
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
        username: string;
        email: string;
        url: string;
        title: string;
        description: string | null;
        attachments?: unknown;
        type: string;
        status: string;
        createdAt: string;
      }[]>('/feedback');
    },
    updateStatus(id: string, status: string) {
      return request<{ id: string; status: string }>(`/feedback/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
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
