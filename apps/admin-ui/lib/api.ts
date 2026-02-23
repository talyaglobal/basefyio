import { getAccessToken, clearTokens } from './auth';
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
};
