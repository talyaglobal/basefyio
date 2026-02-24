import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './auth';
import type {
  AuthTokens,
  ColumnInfo,
  ConnectionStrings,
  PendingInvite,
  Project,
  ProjectListItem,
  RealmInfo,
  RealmUser,
  SqlResult,
  StorageBucket,
  StorageObject,
  TableInfo,
  TableRows,
  Team,
  TeamInvite,
  TeamMember,
  UserInfo,
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

  return res.json();
}

export const api = {
  auth: {
    signup(data: { username: string; email: string; password: string; firstName?: string; lastName?: string }) {
      return request<AuthTokens>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    login(username: string, password: string) {
      return request<AuthTokens>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },
    me() {
      return request<UserInfo>('/auth/me');
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
    listMembers(teamId: string) {
      return request<TeamMember[]>(`/teams/${teamId}/members`);
    },
    removeMember(teamId: string, userId: string) {
      return request<{ message: string }>(`/teams/${teamId}/members/${userId}`, {
        method: 'DELETE',
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
    create(data: { name: string; description?: string; teamId: string }) {
      return request<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    delete(id: string) {
      return request<{ message: string }>(`/projects/${id}`, {
        method: 'DELETE',
      });
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
    connect(projectId: string) {
      return request<ConnectionStrings>(`/projects/${projectId}/connect`);
    },
    realmInfo(projectId: string) {
      return request<RealmInfo>(`/projects/${projectId}/auth`);
    },
    realmUsers(projectId: string) {
      return request<RealmUser[]>(`/projects/${projectId}/auth/users`);
    },
    createRealmUser(projectId: string, data: { username: string; email: string; password: string; firstName?: string; lastName?: string }) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteRealmUser(projectId: string, userId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}`, {
        method: 'DELETE',
      });
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
    create(data: { url: string; title: string; description?: string; type?: string }) {
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
};
