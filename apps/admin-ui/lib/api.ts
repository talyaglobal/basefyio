import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './auth';
import { openTicketedEventSource } from './ticketed-event-source';
import type { ConsoleOverview, ConsoleProjectDetail, ConsoleProjectList, ConsoleStorage, ConsoleDisk } from './console-types';
import type { ConsoleAlertFeed } from './console-alert-types';
import type { RlsMutationOptions, RlsMutationResult, RlsPoliciesOverview, RlsPolicyInput } from './rls-policies';
import type {
  EmbeddingDisclosure,
  EmbeddingProviderCatalogue,
  EmbeddingStatus,
  SetEmbeddingApiKeyOptions,
  SetEmbeddingApiKeyResult,
  SetEmbeddingProviderBody,
  SetEmbeddingProviderResult,
} from './embeddings';
import type {
  AuthTokens,
  MfaStatus,
  TeamSecurity,
  AuditSinkStatus,
  AuditSinkTestResult,
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
  BackupHealth,
  BackupVerification,
  PreviewBranchCreateResponse,
  PreviewBranchListItem,
  PitrRecoveryWindow,
  ProjectAuthConfig,
  ProjectExportJobResponse,
  ProjectExportRequest,
  ProjectListItem,
  RealmInfo,
  RealmUser,
  RealmUserDetail,
  RealmSession,
  RealmSessionFull,
  MfaUser,
  RealmPolicies,
  SqlResult,
  SqlHistoryEntry,
  SqlSnippet,
  StorageBucket,
  StorageObject,
  SupabaseImportRequest,
  SupabaseImportJobResponse,
  SupabaseValidateResult,
  RepairImportKeysRequest,
  PrimaryKeyRepairSummary,
  TableInfo,
  TableRows,
  DataImportInspectResult,
  DataImportPlan,
  DataImportProgress,
  DataImportResult,
  DataImportJobStatus,
  DataImportEncoding,
  DataQueryCapabilities,
  DataQueryResult,
  SavedDataQueryItem,
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
  ManagementDistributionStats,
  MarketingAgencyStatus,
  MarketingCampaign,
  MarketingChannel,
  MarketingVoice,
  MarketingPublishMode,
  CreateMarketingCampaignInput,
  RolePermissionMatrix,
  UserProfile,
  RootAlert,
  AuditLogEntry,
  ProjectDeletionReasonEntry,
  VercelDeployment,
  VercelIntegration,
  VercelProject,
  Flow,
  FlowInput,
  FlowRun,
  AnalyzeBlueprintInput,
  ApplicationModel,
  BlueprintSummary,
  BlueprintDetail,
  BlueprintGenerateResult,
  BlueprintSheet,
  MigrationRun,
  ApiToken,
  ApiTokenScopeGroup,
  CreateApiTokenInput,
  CreatedApiToken,
  TeamCostReport,
  PlatformCostReport,
  InfraCostConfig,
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

/** Hung requests (e.g. the gateway holding a dead upstream mid-deploy)
 *  must resolve into the caller's error path instead of spinning forever. */
const REQUEST_TIMEOUT_MS = 65_000;

/** `code` carried by errors for requests that never reached the server. */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';

function networkError(): Error & { code: string; status: number } {
  const err = new Error(
    'Could not reach the server. Check your connection and try again.',
  ) as Error & { code: string; status: number };
  err.code = NETWORK_ERROR_CODE;
  err.status = 0;
  return err;
}

/** True for an error thrown because the request never reached the server. */
export function isNetworkError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === NETWORK_ERROR_CODE;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`/api/proxy${path}`, {
      signal: controller.signal,
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // A caller that passed its own signal (e.g. a cancel button) aborted on
      // purpose; let it see its own AbortError rather than a timeout message.
      if (options.signal?.aborted) throw err;
      throw new Error('Request timed out — the server may be restarting. Try again shortly.');
    }
    // fetch() rejects with a bare TypeError ("Failed to fetch") when the
    // request never reached the server: offline, DNS, a dropped connection.
    // Say that in words, and mark it so pages can offer a retry instead of
    // reading the failure as an empty result.
    throw networkError();
  } finally {
    clearTimeout(timeout);
  }

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
        // Refresh endpoint reached but rejected the credentials (400/401) — the
        // refresh token is genuinely invalid (e.g. the Keycloak SSO session was
        // dropped). Per product rule, force a clean re-login: clear tokens and
        // redirect to /login instead of leaving the user stuck on an error
        // screen. (Transient 5xx/network failures below do NOT log out.)
        if (refreshRes.status === 400 || refreshRes.status === 401) {
          clearTokens();
          if (
            typeof window !== 'undefined' &&
            !window.location.pathname.startsWith('/login')
          ) {
            window.location.assign('/login');
          }
          throw new Error('Session expired');
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

/**
 * Trade the refresh token for a new access token after a 401. Same rules as
 * request(): a rejected refresh (400/401) clears the session and goes to
 * /login; a transient failure returns null and logs nobody out.
 */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  let refreshRes: Response;
  try {
    refreshRes = await fetch('/api/proxy/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return null;
  }
  if (refreshRes.ok) {
    const tokens: AuthTokens = await parseOkJsonBody<AuthTokens>(refreshRes);
    setTokens(tokens);
    return tokens.accessToken;
  }
  if (refreshRes.status === 400 || refreshRes.status === 401) {
    clearTokens();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    throw new Error('Session expired');
  }
  return null;
}

/**
 * fetch() with the access token in the Authorization header, refreshing once
 * on 401. For streams, downloads and uploads that cannot go through
 * request() — and so that tokens never have to travel in a URL.
 */
export async function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null | undefined) =>
    fetch(url, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  const res = await send(getAccessToken());
  if (res.status !== 401) return res;
  const fresh = await refreshAccessToken();
  return fresh ? send(fresh) : res;
}

/** Error from a failed proxy response, using the server's message when there is one. */
export async function responseError(res: Response, fallback: string): Promise<Error & { status?: number }> {
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
  const err = new Error(message || `${fallback}: ${res.status}`) as Error & { status?: number };
  err.status = res.status;
  return err;
}

/** Filename from a Content-Disposition header. */
function dispositionFilename(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

export const api = {
  auth: {
    /**
     * Single-use ticket for one event stream (see lib/ticketed-event-source.ts):
     * the stream URL carries this instead of the access token.
     */
    streamTicket(path: string) {
      return request<{ ticket: string; expiresIn: number }>('/auth/stream-ticket', {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
    },
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
    mfaStatus() {
      return request<MfaStatus>('/auth/mfa');
    },
    mfaEnrollUrl(next?: string) {
      return request<{ url: string }>('/auth/mfa/enroll-url', {
        method: 'POST',
        body: JSON.stringify(next ? { next } : {}),
      });
    },
    disableMfa(password: string, code: string) {
      return request<{ message: string; removed: number }>('/auth/mfa', {
        method: 'DELETE',
        body: JSON.stringify({ password, code }),
      });
    },
    resetManagementUserMfa(userId: string) {
      return request<{ message: string; removed: number }>(
        `/auth/management/users/${userId}/reset-mfa`,
        { method: 'POST' },
      );
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
      return request<{
        message: string;
        autoSignedIn?: boolean;
        accessToken?: string;
        refreshToken?: string;
      }>('/auth/reset-password', {
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
    unlockManagementUser(userId: string) {
      return request<{ unlocked: boolean }>(
        `/auth/management/users/${userId}/unlock`,
        { method: 'POST' },
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
    managementDistribution() {
      return request<ManagementDistributionStats>('/auth/management/marketing/distribution');
    },
  },

  // The in-house marketing agency: Claude writes it, fal.ai and ElevenLabs
  // render it, Pubbler publishes it.
  marketingAgency: {
    status() {
      return request<MarketingAgencyStatus>('/auth/management/marketing-agency/status');
    },
    channels() {
      return request<MarketingChannel[]>('/auth/management/marketing-agency/channels');
    },
    voices() {
      return request<MarketingVoice[]>('/auth/management/marketing-agency/voices');
    },
    listCampaigns() {
      return request<MarketingCampaign[]>('/auth/management/marketing-agency/campaigns');
    },
    getCampaign(id: string) {
      return request<MarketingCampaign>(`/auth/management/marketing-agency/campaigns/${id}`);
    },
    createCampaign(input: CreateMarketingCampaignInput) {
      return request<MarketingCampaign>('/auth/management/marketing-agency/campaigns', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    rewriteCopy(id: string) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/copy`,
        { method: 'POST' },
      );
    },
    editCopy(
      id: string,
      patch: {
        caption?: string;
        hashtags?: string[];
        imagePrompt?: string;
        videoPrompt?: string;
        voiceScript?: string;
      },
    ) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/copy`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
    },
    renderImage(id: string) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/image`,
        { method: 'POST' },
      );
    },
    renderVideo(id: string) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/video`,
        { method: 'POST' },
      );
    },
    renderVoiceover(id: string, voiceId?: string) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/voiceover`,
        { method: 'POST', body: JSON.stringify({ voiceId }) },
      );
    },
    selectAsset(id: string, assetId: string) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/assets/${assetId}/select`,
        { method: 'POST' },
      );
    },
    publish(
      id: string,
      body: { mode: MarketingPublishMode; date?: string; postType?: 'post' | 'story' },
    ) {
      return request<MarketingCampaign>(
        `/auth/management/marketing-agency/campaigns/${id}/publish`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    deleteCampaign(id: string) {
      return request<{ deleted: boolean }>(
        `/auth/management/marketing-agency/campaigns/${id}`,
        { method: 'DELETE' },
      );
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
    getSecurity(teamId: string) {
      return request<TeamSecurity>(`/teams/${teamId}/security`);
    },
    setRequireMfa(teamId: string, requireMfa: boolean) {
      return request<{ id: string; requireMfa: boolean; requireMfaUpdatedAt: string | null }>(
        `/teams/${teamId}/security`,
        { method: 'PATCH', body: JSON.stringify({ requireMfa }) },
      );
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
    sendInvite(teamId: string, usernameOrEmail: string, role?: 'ADMIN' | 'MEMBER') {
      return request<{ message: string }>(`/teams/${teamId}/invites`, {
        method: 'POST',
        body: JSON.stringify(role ? { usernameOrEmail, role } : { usernameOrEmail }),
      });
    },
    leaveTeam(teamId: string) {
      return request<{ message: string }>(`/teams/${teamId}/leave`, { method: 'POST' });
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
      // Page loads never need the credentials; the Connection page fetches them
      // from /connect when it is opened.
      return request<Project>(`/projects/${id}?secrets=omit`);
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
    create(data: {
      name: string;
      description?: string;
      teamId: string;
      databaseType?: 'RELATIONAL' | 'NOSQL';
    }) {
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
    // Pass an empty teamId for the "All Teams" view — the API then returns
    // deleted projects across every team the user belongs to.
    listDeleted(teamId: string) {
      return request<ProjectListItem[]>(
        `/projects/deleted?teamId=${encodeURIComponent(teamId || '')}`,
      );
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
    listDeactivated(teamId: string) {
      return request<ProjectListItem[]>(
        `/projects/deactivated?teamId=${encodeURIComponent(teamId || '')}`,
      );
    },
    deactivate(id: string) {
      return request<{ message: string }>(`/projects/${id}/deactivate`, {
        method: 'POST',
      });
    },
    reactivate(id: string) {
      return request<{ message: string }>(`/projects/${id}/reactivate`, {
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
    setMaxRowsPerTable(projectId: string, maxRowsPerTable: number) {
      return request<{ maxRowsPerTable: number; planCeiling: number }>(
        `/projects/${projectId}/max-rows`,
        { method: 'PATCH', body: JSON.stringify({ maxRowsPerTable }) },
      );
    },
    dbIndexes(projectId: string) {
      return request<any[]>(`/projects/${projectId}/database/indexes`);
    },
    dbCreateIndex(projectId: string, data: { table: string; columns: string[]; unique?: boolean; method?: string }) {
      return request<{ message: string }>(`/projects/${projectId}/database/indexes`, { method: 'POST', body: JSON.stringify(data) });
    },
    dbDropIndex(projectId: string, name: string) {
      return request<{ message: string }>(`/projects/${projectId}/database/indexes/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    dbTriggers(projectId: string) {
      return request<any[]>(`/projects/${projectId}/database/triggers`);
    },
    dbCreateTrigger(projectId: string, data: { name: string; table: string; timing: string; events: string[]; functionName: string }) {
      return request<{ message: string }>(`/projects/${projectId}/database/triggers`, { method: 'POST', body: JSON.stringify(data) });
    },
    dbToggleTrigger(projectId: string, data: { name: string; table: string; enabled: boolean }) {
      return request<{ message: string }>(`/projects/${projectId}/database/triggers/toggle`, { method: 'PUT', body: JSON.stringify(data) });
    },
    dbDropTrigger(projectId: string, table: string, name: string) {
      return request<{ message: string }>(`/projects/${projectId}/database/triggers/${encodeURIComponent(table)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    dbFunctions(projectId: string) {
      return request<any[]>(`/projects/${projectId}/database/functions`);
    },
    dbCreateFunction(projectId: string, sql: string) {
      return request<{ message: string }>(`/projects/${projectId}/database/functions`, { method: 'POST', body: JSON.stringify({ sql }) });
    },
    dbDropFunction(projectId: string, name: string, args?: string) {
      const qs = args ? `?args=${encodeURIComponent(args)}` : '';
      return request<{ message: string }>(`/projects/${projectId}/database/functions/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
    },
    dbExtensions(projectId: string) {
      return request<any[]>(`/projects/${projectId}/database/extensions`);
    },
    dbSetExtension(projectId: string, data: { name: string; enabled: boolean }) {
      return request<{ message: string }>(`/projects/${projectId}/database/extensions`, { method: 'PUT', body: JSON.stringify(data) });
    },
    dbInstallDefaultExtensions(projectId: string) {
      return request<{ installed: string[]; skipped: { statement: string; error: string }[]; error?: string }>(
        `/projects/${projectId}/database/extensions/defaults`,
        { method: 'POST' },
      );
    },
    // Row-level security policies. `dryRun` returns the SQL without running it;
    // `dryRun` + `check` runs it inside a transaction that is rolled back.
    dbPolicies(projectId: string) {
      return request<RlsPoliciesOverview>(`/projects/${projectId}/database/policies`);
    },
    dbCreatePolicy(projectId: string, data: RlsPolicyInput & RlsMutationOptions) {
      return request<RlsMutationResult>(`/projects/${projectId}/database/policies`, { method: 'POST', body: JSON.stringify(data) });
    },
    dbReplacePolicy(projectId: string, table: string, name: string, data: Omit<RlsPolicyInput, 'table'> & RlsMutationOptions) {
      return request<RlsMutationResult>(
        `/projects/${projectId}/database/policies/${encodeURIComponent(table)}/${encodeURIComponent(name)}`,
        { method: 'PUT', body: JSON.stringify(data) },
      );
    },
    dbDropPolicy(projectId: string, table: string, name: string, opts: RlsMutationOptions = {}) {
      const qs = new URLSearchParams();
      if (opts.dryRun) qs.set('dryRun', 'true');
      if (opts.check) qs.set('check', 'true');
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<RlsMutationResult>(
        `/projects/${projectId}/database/policies/${encodeURIComponent(table)}/${encodeURIComponent(name)}${suffix}`,
        { method: 'DELETE' },
      );
    },
    dbSetRls(projectId: string, data: { table: string; enabled: boolean; force?: boolean } & RlsMutationOptions) {
      return request<RlsMutationResult>(`/projects/${projectId}/database/policies/rls`, { method: 'POST', body: JSON.stringify(data) });
    },
    listRealtimeBindings(projectId: string) {
      return request<{ kind: 'table' | 'collection'; entity: string; createdAt: string }[]>(
        `/projects/${projectId}/realtime-bindings`,
      );
    },
    setRealtimeBinding(
      projectId: string,
      data: { kind: 'table' | 'collection'; entity: string; enabled: boolean },
    ) {
      return request<{ kind: string; entity: string; enabled: boolean }>(
        `/projects/${projectId}/realtime-bindings`,
        { method: 'PUT', body: JSON.stringify(data) },
      );
    },
    importFromSupabase(data: SupabaseImportRequest) {
      return request<SupabaseImportJobResponse>('/projects/import-supabase', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    /**
     * Upload an export ZIP. With onUploadProgress the upload goes through
     * XMLHttpRequest so the dialog can show a real percentage (fetch() cannot
     * report upload progress). confirmProjectName is the typed confirmation for
     * an overwrite; the server checks it against the target's name.
     */
    async importFromExportZip(data: {
      file: File;
      teamId: string;
      nameMode: 'existing' | 'new';
      newProjectName?: string;
      existingProjectId?: string;
      confirmProjectName?: string;
      onUploadProgress?: (loaded: number, total: number) => void;
    }) {
      const form = new FormData();
      form.append('file', data.file);
      form.append('teamId', data.teamId);
      form.append('nameMode', data.nameMode);
      if (data.nameMode === 'new' && data.newProjectName?.trim()) {
        form.append('newProjectName', data.newProjectName.trim());
      }
      if (data.existingProjectId?.trim()) {
        form.append('existingProjectId', data.existingProjectId.trim());
        if (data.confirmProjectName !== undefined) {
          form.append('confirmProjectName', data.confirmProjectName);
        }
      }

      const url = '/api/proxy/projects/import-export-zip';
      if (!data.onUploadProgress) {
        const res = await authorizedFetch(url, { method: 'POST', body: form });
        if (!res.ok) throw await responseError(res, 'ZIP import failed');
        return (await res.json()) as ProjectArchiveImportResponse;
      }

      const onProgress = data.onUploadProgress;
      const send = (token: string | null | undefined) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url);
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
          };
          xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
          xhr.onerror = () => reject(networkError());
          xhr.send(form);
        });
      let res = await send(getAccessToken());
      if (res.status === 401) {
        const fresh = await refreshAccessToken();
        if (fresh) res = await send(fresh);
      }
      let body: any = {};
      try {
        body = res.body ? JSON.parse(res.body) : {};
      } catch {
        body = { message: res.body.slice(0, 200) };
      }
      if (res.status < 200 || res.status >= 300) {
        const message = Array.isArray(body?.message) ? body.message.join(' ') : body?.message;
        throw new Error(message || `ZIP import failed: ${res.status}`);
      }
      return body as ProjectArchiveImportResponse;
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
    /** Add the source's primary keys to imported tables that arrived without one (dry run by request). */
    repairSupabaseImportKeys(projectId: string, data: RepairImportKeysRequest) {
      return request<PrimaryKeyRepairSummary>(
        `/projects/${projectId}/import-supabase/repair-keys`,
        { method: 'POST', body: JSON.stringify(data) },
      );
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
      const es = openTicketedEventSource({
        proxyPath: `/api/proxy/projects/${projectId}/export/jobs/${jobId}/events`,
        apiPath: `/api/projects/${projectId}/export/jobs/${jobId}/events`,
        mint: (path) => api.auth.streamTicket(path),
        legacy: { param: 'token', token: getAccessToken },
      });

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
    /** Range of timestamps this project can currently be recovered to. */
    getRecoveryWindow(projectId: string) {
      return request<PitrRecoveryWindow>(`/projects/${projectId}/pitr/window`);
    },
    /** Recover the project database to an exact instant inside the window. */
    restoreToTimestamp(projectId: string, targetTime: string) {
      return request<{
        restoredTo: string;
        /** False when only a snapshot was available, so restoredTo is not the time you asked for. */
        exact?: boolean;
        baseBackupTaken?: string;
        message: string;
      }>(
        `/projects/${projectId}/pitr/restore`,
        { method: 'POST', body: JSON.stringify({ targetTime }) },
      );
    },
    restoreCloudBackup(
      projectId: string,
      data: {
        objectKey: string;
        teamId: string;
        nameMode: 'existing' | 'new';
        newProjectName?: string;
        existingProjectId?: string;
        kind?: 'manual' | 'auto';
        /** Typed confirmation for an overwrite; must equal the project's name. */
        confirmProjectName?: string;
      },
    ) {
      return request<ProjectArchiveImportResponse>(`/projects/${projectId}/backups/restore`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    /** "Back up now": same content and retention as a nightly backup. Follow the job like an export. */
    runBackupNow(projectId: string) {
      return request<{ jobId: string }>(`/projects/${projectId}/backups/run`, { method: 'POST' });
    },
    /** Download one stored archive as a plain ZIP (decrypted when stored encrypted). */
    async downloadCloudBackup(
      projectId: string,
      objectKey: string,
      kind: 'manual' | 'auto' = 'manual',
    ): Promise<{ blob: Blob; filename: string }> {
      const qs = new URLSearchParams({ objectKey, kind }).toString();
      const res = await authorizedFetch(`/api/proxy/projects/${projectId}/backups/download?${qs}`);
      if (!res.ok) throw await responseError(res, 'Download failed');
      return {
        blob: await res.blob(),
        filename: dispositionFilename(res, objectKey.split('/').pop() || 'backup.zip'),
      };
    },
    /** Delete a manual export or an on-demand backup (nightly backups expire on their own). */
    deleteCloudBackup(projectId: string, objectKey: string, kind: 'manual' | 'auto' = 'manual') {
      const qs = new URLSearchParams({ objectKey, kind }).toString();
      return request<{ deleted: string }>(`/projects/${projectId}/backups/archive?${qs}`, {
        method: 'DELETE',
      });
    },
    /** Take this project's point-in-time snapshot now (runs in the background). */
    takePitrSnapshot(projectId: string) {
      return request<{ started: boolean; message: string }>(`/projects/${projectId}/pitr/snapshot`, {
        method: 'POST',
      });
    },
    /** Off-site copy state, local encryption and restore-verification verdicts for the Backup page. */
    backupHealth(projectId: string) {
      return request<BackupHealth>(`/projects/${projectId}/backups/health`);
    },
    listBackupVerifications(projectId: string, limit = 10) {
      return request<BackupVerification[]>(`/projects/${projectId}/backups/verifications?limit=${limit}`);
    },
    /** Rebuild the newest nightly archive into a throwaway database now; the verdict lands in backupHealth(). */
    verifyBackup(projectId: string) {
      return request<{ verificationId: string }>(`/projects/${projectId}/backups/verify`, { method: 'POST' });
    },
    listBranches(projectId: string) {
      return request<PreviewBranchListItem[]>(`/projects/${projectId}/branches`);
    },
    createBranch(projectId: string, data: { name: string; dataMode?: 'schema' | 'full' }) {
      return request<PreviewBranchCreateResponse>(`/projects/${projectId}/branches`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteBranch(projectId: string, branchId: string) {
      return request<{ message: string }>(`/projects/${projectId}/branches/${branchId}`, { method: 'DELETE' });
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
      const es = openTicketedEventSource({
        proxyPath: `/api/proxy/projects/import-supabase/jobs/${jobId}/events`,
        apiPath: `/api/projects/import-supabase/jobs/${jobId}/events`,
        mint: (path) => api.auth.streamTicket(path),
        legacy: { param: 'token', token: getAccessToken },
      });

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
      columns: { name: string; type: string; nullable: boolean; isPrimary: boolean; defaultValue?: string; isUnique?: boolean }[];
    }) {
      return request<{ message: string; sql: string; name?: string }>(`/projects/${projectId}/tables`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    renameTable(projectId: string, tableName: string, name: string, schema?: string) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<{ message: string; name: string; schema?: string }>(
        `/projects/${projectId}/tables/${encodeURIComponent(tableName)}${qs}`,
        { method: 'PUT', body: JSON.stringify({ name }) },
      );
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
    /**
     * `expectedVersion` is the row's `_bf_xmin` as it was read: the update then
     * fails with 409 (code ROW_CHANGED) if someone changed the row since.
     */
    updateRow(
      projectId: string,
      tableName: string,
      pkWhere: Record<string, unknown>,
      data: Record<string, unknown>,
      schema?: string,
      expectedVersion?: string,
    ) {
      const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
      return request<Record<string, unknown>>(`/projects/${projectId}/tables/${tableName}/rows${qs}`, {
        method: 'PUT',
        body: JSON.stringify(expectedVersion ? { pkWhere, data, expectedVersion } : { pkWhere, data }),
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
      return request<{ message: string; name?: string }>(`/projects/${projectId}/tables/${tableName}/columns/${columnName}`, {
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
    // ── Collections (NoSQL) ────────────────────────────────
    listCollections(projectId: string) {
      return request<import('./types').CollectionInfo[]>(`/projects/${projectId}/collections`);
    },
    createCollection(projectId: string, name: string) {
      return request<{ message: string }>(`/projects/${projectId}/collections`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },
    dropCollection(projectId: string, collectionName: string) {
      return request<{ message: string }>(`/projects/${projectId}/collections/${encodeURIComponent(collectionName)}`, {
        method: 'DELETE',
      });
    },
    collectionDocuments(
      projectId: string,
      collectionName: string,
      opts: { filter?: Record<string, unknown>; sort?: Record<string, number>; limit?: number; offset?: number } = {},
    ) {
      const params = new URLSearchParams();
      if (opts.filter && Object.keys(opts.filter).length > 0) params.set('filter', JSON.stringify(opts.filter));
      if (opts.sort && Object.keys(opts.sort).length > 0) params.set('sort', JSON.stringify(opts.sort));
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.offset !== undefined) params.set('offset', String(opts.offset));
      const qs = params.toString();
      return request<import('./types').DocumentListResult>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents${qs ? `?${qs}` : ''}`,
      );
    },
    insertDocument(projectId: string, collectionName: string, doc: Record<string, unknown> | Record<string, unknown>[]) {
      return request<import('./types').DocumentRecord[]>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents`,
        { method: 'POST', body: JSON.stringify(doc) },
      );
    },
    getDocument(projectId: string, collectionName: string, docId: string) {
      return request<import('./types').DocumentRecord>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents/${docId}`,
      );
    },
    updateDocument(projectId: string, collectionName: string, docId: string, update: Record<string, unknown>) {
      return request<import('./types').DocumentRecord>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents/${docId}`,
        { method: 'PATCH', body: JSON.stringify(update) },
      );
    },
    replaceDocument(projectId: string, collectionName: string, docId: string, doc: Record<string, unknown>) {
      return request<import('./types').DocumentRecord>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents/${docId}`,
        { method: 'PUT', body: JSON.stringify(doc) },
      );
    },
    deleteDocument(projectId: string, collectionName: string, docId: string) {
      return request<{ message: string }>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents/${docId}`,
        { method: 'DELETE' },
      );
    },
    bulkDeleteDocuments(projectId: string, collectionName: string, filter: Record<string, unknown>) {
      return request<{ deleted: number }>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/documents`,
        { method: 'DELETE', body: JSON.stringify({ filter }) },
      );
    },
    collectionCount(projectId: string, collectionName: string, filter?: Record<string, unknown>) {
      const qs = filter && Object.keys(filter).length > 0 ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
      return request<{ count: number }>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/count${qs}`,
      );
    },
    createCollectionIndex(projectId: string, collectionName: string, fieldPath: string) {
      return request<{ message: string }>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/indexes`,
        { method: 'POST', body: JSON.stringify({ fieldPath }) },
      );
    },
    listCollectionIndexes(projectId: string, collectionName: string) {
      return request<import('./types').CollectionIndexInfo[]>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/indexes`,
      );
    },
    dropCollectionIndex(projectId: string, collectionName: string, indexName: string) {
      return request<{ message: string }>(
        `/projects/${projectId}/collections/${encodeURIComponent(collectionName)}/indexes/${encodeURIComponent(indexName)}`,
        { method: 'DELETE' },
      );
    },

    // ── Data Engine ──────────────────────────────────────
    dataEngineHealth(projectId: string) {
      return request<import('./types').DataEngineHealth>(`/v1/projects/${projectId}/data-engine/health`);
    },
    listEntityDefinitions(projectId: string, opts: { withCounts?: boolean } = {}) {
      return request<import('./types').EntityDefinitionInfo[]>(
        `/v1/projects/${projectId}/entities${opts.withCounts ? '?withCounts=true' : ''}`,
      );
    },
    updateEntityDefinition(
      projectId: string,
      entityName: string,
      data: { displayName?: string; description?: string | null; fields?: unknown[] },
    ) {
      return request<import('./types').EntityDefinitionInfo>(
        `/v1/projects/${projectId}/entities/${encodeURIComponent(entityName)}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      );
    },
    deleteEntityDefinition(projectId: string, entityName: string, force = false) {
      return request<{ deleted: boolean; entity: string; documentsRemoved: number }>(
        `/v1/projects/${projectId}/entities/${encodeURIComponent(entityName)}${force ? '?force=true' : ''}`,
        { method: 'DELETE' },
      );
    },
    createEntityDefinition(projectId: string, data: { logicalName: string; displayName: string; fields: unknown[]; description?: string }) {
      return request<import('./types').EntityDefinitionInfo>(`/v1/projects/${projectId}/entities`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    getEntityDefinition(projectId: string, entityName: string) {
      return request<import('./types').EntityDefinitionInfo>(`/v1/projects/${projectId}/entities/${encodeURIComponent(entityName)}`);
    },
    dataEngineDocuments(
      projectId: string,
      entityName: string,
      opts: {
        filter?: Record<string, unknown>;
        sort?: unknown[];
        limit?: number;
        offset?: number;
        includeSoftDeleted?: boolean;
      } = {},
    ) {
      const params = new URLSearchParams();
      if (opts.filter && Object.keys(opts.filter).length > 0) params.set('filter', JSON.stringify(opts.filter));
      if (opts.sort && opts.sort.length > 0) params.set('sort', JSON.stringify(opts.sort));
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.offset !== undefined) params.set('offset', String(opts.offset));
      if (opts.includeSoftDeleted) params.set('includeSoftDeleted', 'true');
      const qs = params.toString();
      return request<import('./types').DataEnginePage>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}${qs ? `?${qs}` : ''}`,
      );
    },
    insertDataEngineDocument(projectId: string, entityName: string, doc: Record<string, unknown>) {
      return request<import('./types').DataEngineDoc>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}`,
        { method: 'POST', body: JSON.stringify(doc) },
      );
    },
    /** Bulk insert (max 1000 per call); every document is validated before any is written. */
    insertDataEngineDocuments(projectId: string, entityName: string, docs: Record<string, unknown>[]) {
      return request<import('./types').DataEngineDoc[]>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}`,
        { method: 'POST', body: JSON.stringify(docs) },
      );
    },
    getDataEngineDocument(projectId: string, entityName: string, docId: string) {
      return request<import('./types').DataEngineDoc>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}/${docId}`,
      );
    },
    updateDataEngineDocument(projectId: string, entityName: string, docId: string, patch: Record<string, unknown>) {
      return request<import('./types').DataEngineDoc>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}/${docId}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
    },
    /** Full replacement; with ifMatch the write fails (409) if the document changed since it was read. */
    replaceDataEngineDocument(
      projectId: string,
      entityName: string,
      docId: string,
      doc: Record<string, unknown>,
      ifMatch?: number,
    ) {
      return request<import('./types').DataEngineDoc>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}/${docId}`,
        {
          method: 'PUT',
          body: JSON.stringify(doc),
          ...(ifMatch !== undefined ? { headers: { 'If-Match': `"${ifMatch}"` } } : {}),
        },
      );
    },
    restoreDataEngineDocument(projectId: string, entityName: string, docId: string) {
      return request<import('./types').DataEngineDoc>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}/${docId}/restore`,
        { method: 'POST' },
      );
    },
    deleteDataEngineDocument(projectId: string, entityName: string, docId: string) {
      return request<void>(
        `/v1/projects/${projectId}/data/${encodeURIComponent(entityName)}/${docId}`,
        { method: 'DELETE' },
      );
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
    createReadonlyRole(projectId: string) {
      return request<{ user: string; password: string; warnings: string[] }>(
        `/projects/${projectId}/db-readonly-role`,
        { method: 'POST' },
      );
    },
    rotateReadonlyPassword(projectId: string, password?: string) {
      return request<{ password: string }>(`/projects/${projectId}/db-readonly-password`, {
        method: 'PATCH',
        body: JSON.stringify(password ? { password } : {}),
      });
    },
    dropReadonlyRole(projectId: string) {
      return request<{ message: string; warnings: string[] }>(
        `/projects/${projectId}/db-readonly-role`,
        { method: 'DELETE' },
      );
    },
    setDbConnectionLimit(projectId: string, maxDbConnections: number | null) {
      return request<{
        maxDbConnections: number | null;
        planCeiling: number;
        effective: number | null;
        source: 'project' | 'plan' | 'platform' | 'none';
      }>(`/projects/${projectId}/db-connection-limit`, {
        method: 'PATCH',
        body: JSON.stringify({ maxDbConnections }),
      });
    },
    realmInfo(projectId: string) {
      return request<RealmInfo>(`/projects/${projectId}/auth`);
    },
    repairRealm(projectId: string) {
      return request<{ message: string; realm: string; previousRealm?: string }>(
        `/projects/${projectId}/auth/repair`,
        { method: 'POST' },
      );
    },
    realmUsers(projectId: string, opts: { search?: string; first?: number; max?: number } = {}) {
      const qs = new URLSearchParams();
      if (opts.search) qs.set('search', opts.search);
      if (opts.first !== undefined) qs.set('first', String(opts.first));
      if (opts.max !== undefined) qs.set('max', String(opts.max));
      const q = qs.toString();
      return request<RealmUser[]>(`/projects/${projectId}/auth/users${q ? `?${q}` : ''}`);
    },
    countRealmUsers(projectId: string, search?: string) {
      const q = search ? `?search=${encodeURIComponent(search)}` : '';
      return request<{ count: number }>(`/projects/${projectId}/auth/users/count${q}`);
    },
    /** Try email settings (saved, or the unsaved ones in `settings`) by sending a test message. */
    testAuthEmail(projectId: string, body: { to?: string; settings?: Record<string, unknown> }) {
      return request<{ ok: boolean; provider: string; to: string; error?: string }>(
        `/projects/${projectId}/auth/config/email/test`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    createRealmUser(projectId: string, data: { email: string; password: string; firstName?: string; lastName?: string }) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    realmSessions(projectId: string) {
      return request<RealmSessionFull[]>(`/projects/${projectId}/auth/sessions`);
    },
    revokeRealmSession(projectId: string, sessionId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    },
    realmMfaUsers(projectId: string) {
      return request<MfaUser[]>(`/projects/${projectId}/auth/mfa`);
    },
    requireRealmUserMfa(projectId: string, userId: string, enabled = true) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/require-mfa`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
    },
    removeRealmUserMfa(projectId: string, userId: string, credentialId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/credentials/${credentialId}`, {
        method: 'DELETE',
      });
    },
    /** Reset an authenticator app the user enrolled through the SDK. */
    removeRealmUserAppMfa(projectId: string, userId: string) {
      return request<{ enabled: false }>(`/projects/${projectId}/auth/users/${userId}/mfa`, {
        method: 'DELETE',
      });
    },
    /** Delete anonymous users older than N days; dryRun only counts them. */
    purgeAnonymousUsers(projectId: string, body: { olderThanDays?: number; dryRun?: boolean }) {
      return request<{ matched: number; deleted: number; olderThanDays: number; dryRun: boolean }>(
        `/projects/${projectId}/auth/anonymous/purge`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    getAuthPolicies(projectId: string) {
      return request<RealmPolicies>(`/projects/${projectId}/auth/policies`);
    },
    updateAuthPolicies(projectId: string, data: Record<string, unknown>) {
      return request<RealmPolicies>(`/projects/${projectId}/auth/policies`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    updateRealmUser(projectId: string, userId: string, data: { firstName?: string; lastName?: string; email?: string; enabled?: boolean; phoneNumber?: string; phoneVerified?: boolean }) {
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
    realmUserDetail(projectId: string, userId: string) {
      return request<RealmUserDetail>(`/projects/${projectId}/auth/users/${userId}`);
    },
    realmUserSessions(projectId: string, userId: string) {
      return request<RealmSession[]>(`/projects/${projectId}/auth/users/${userId}/sessions`);
    },
    revokeRealmUserSession(projectId: string, userId: string, sessionId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    },
    logoutRealmUser(projectId: string, userId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/logout`, {
        method: 'POST',
      });
    },
    sendRealmUserRecovery(projectId: string, userId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/send-recovery`, {
        method: 'POST',
      });
    },
    sendRealmUserVerification(projectId: string, userId: string) {
      return request<{ message: string }>(`/projects/${projectId}/auth/users/${userId}/send-verification`, {
        method: 'POST',
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
     * Generic CSV/XLSX/JSON → table import. Wizard flow:
     *   1. inspectDataImport(file)      — upload + preview + auto-detect schema
     *   2. startDataImport(plan)        — kicks off the background job
     *   3. streamDataImportEvents()     — SSE progress (preferred) OR
     *      getDataImportStatus()        — poll
     *   4. fetchDataImportErrors()      — bad-rows CSV after completion
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
      args: {
        sourceKey: string;
        filename: string;
        firstRowIsHeader?: boolean;
        encoding?: DataImportEncoding | 'auto';
      },
    ) {
      return request<DataImportInspectResult>(
        `/projects/${projectId}/data-imports/inspect-staged`,
        { method: 'POST', body: JSON.stringify(args) },
      );
    },
    async inspectDataImport(
      projectId: string,
      file: File,
      opts: { firstRowIsHeader?: boolean; encoding?: DataImportEncoding | 'auto' } = {},
    ): Promise<DataImportInspectResult> {
      const fd = new FormData();
      fd.append('file', file);
      const params = new URLSearchParams();
      if (opts.firstRowIsHeader === false) params.set('firstRowIsHeader', 'false');
      if (opts.encoding && opts.encoding !== 'auto') params.set('encoding', opts.encoding);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await authorizedFetch(`/api/proxy/projects/${projectId}/data-imports/inspect${qs}`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) throw await responseError(res, 'Import inspect failed');
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
    /**
     * Live progress for an import job. Read with fetch() so the access token
     * goes in the Authorization header — an EventSource can only carry it in
     * the URL, where it ends up in proxy and server logs. If the stream drops
     * before the job finishes, it falls back to polling the status endpoint.
     */
    streamDataImportEvents(
      projectId: string,
      jobId: string,
      callbacks: {
        onProgress: (data: DataImportProgress) => void;
        onCompleted: (data: DataImportResult) => void;
        onFailed: (error: string) => void;
        onState?: (state: string) => void;
        onError?: (error: unknown) => void;
      },
    ): { close: () => void } {
      const controller = new AbortController();
      let closed = false;
      let finished = false;
      const handle = (event: string, raw: string) => {
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        if (event === 'state') callbacks.onState?.(data?.state);
        else if (event === 'progress') callbacks.onProgress(data);
        else if (event === 'completed') {
          finished = true;
          controller.abort();
          callbacks.onCompleted(data);
        } else if (event === 'failed') {
          finished = true;
          controller.abort();
          callbacks.onFailed(data?.error || 'Import failed');
        }
      };

      const poll = async () => {
        while (!closed && !finished) {
          try {
            const status = await api.projects.getDataImportStatus(projectId, jobId);
            if (closed || finished) return;
            callbacks.onState?.(status.state);
            if (status.progress && typeof status.progress === 'object') {
              callbacks.onProgress(status.progress as DataImportProgress);
            }
            if (status.state === 'completed') {
              finished = true;
              callbacks.onCompleted((status.result ?? {}) as DataImportResult);
              return;
            }
            if (status.state === 'failed') {
              finished = true;
              callbacks.onFailed(status.failedReason || 'Import failed');
              return;
            }
          } catch (err) {
            callbacks.onError?.(err);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      };

      void (async () => {
        try {
          const res = await authorizedFetch(
            `/api/proxy/projects/${projectId}/data-imports/jobs/${jobId}/events`,
            { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
          );
          if (!res.ok || !res.body) throw await responseError(res, 'Progress stream failed');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!closed && !finished) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep = buffer.indexOf('\n\n');
            while (sep >= 0) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              let event = 'message';
              const data: string[] = [];
              for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trim());
              }
              if (data.length) handle(event, data.join('\n'));
              sep = buffer.indexOf('\n\n');
            }
          }
        } catch (err: any) {
          if (closed || finished || err?.name === 'AbortError') return;
          callbacks.onError?.(err);
        }
        // The stream ended without a final event (proxy timeout, network
        // blip): keep following the job by polling.
        if (!closed && !finished) await poll();
      })();

      return {
        close: () => {
          closed = true;
          controller.abort();
        },
      };
    },
    cancelDataImport(projectId: string, jobId: string) {
      return request<{ ok: boolean }>(
        `/projects/${projectId}/data-imports/jobs/${jobId}/cancel`,
        { method: 'POST' },
      );
    },
    /** Proxy URL of the bad-rows CSV. It needs the Authorization header — download it with fetchDataImportErrors. */
    downloadDataImportErrors(projectId: string, jobId: string): string {
      return `/api/proxy/projects/${projectId}/data-imports/jobs/${jobId}/errors`;
    },
    /** Download the bad-rows CSV of a finished import (row number, reason, raw row). */
    async fetchDataImportErrors(projectId: string, jobId: string): Promise<{ blob: Blob; filename: string }> {
      const res = await authorizedFetch(
        `/api/proxy/projects/${projectId}/data-imports/jobs/${jobId}/errors`,
      );
      if (!res.ok) throw await responseError(res, 'Error report download failed');
      return { blob: await res.blob(), filename: dispositionFilename(res, `import-${jobId}-errors.csv`) };
    },
  },

  flows: {
    list(projectId: string) {
      return request<Flow[]>(`/projects/${projectId}/flows`);
    },
    get(projectId: string, id: string) {
      return request<Flow>(`/projects/${projectId}/flows/${id}`);
    },
    create(projectId: string, data: FlowInput) {
      return request<Flow>(`/projects/${projectId}/flows`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update(projectId: string, id: string, data: Partial<FlowInput>) {
      return request<Flow>(`/projects/${projectId}/flows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    remove(projectId: string, id: string) {
      return request<{ deleted: boolean }>(`/projects/${projectId}/flows/${id}`, {
        method: 'DELETE',
      });
    },
    setEnabled(projectId: string, id: string, enabled: boolean) {
      return request<Flow>(`/projects/${projectId}/flows/${id}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      });
    },
    trigger(projectId: string, id: string, input?: unknown) {
      return request<{ runId: string; status: string }>(`/projects/${projectId}/flows/${id}/trigger`, {
        method: 'POST',
        body: JSON.stringify({ input }),
      });
    },
    runs(projectId: string, id: string, page?: { limit?: number; before?: string }) {
      const qs = new URLSearchParams();
      if (page?.limit) qs.set('limit', String(page.limit));
      if (page?.before) qs.set('before', page.before);
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<FlowRun[]>(`/projects/${projectId}/flows/${id}/runs${suffix}`);
    },
    run(projectId: string, id: string, runId: string) {
      return request<FlowRun>(`/projects/${projectId}/flows/${id}/runs/${runId}`);
    },
    rerun(projectId: string, id: string, runId: string) {
      return request<{ runId: string; status: string }>(`/projects/${projectId}/flows/${id}/runs/${runId}/rerun`, {
        method: 'POST',
      });
    },
    rotateWebhook(projectId: string, id: string, body?: { secret?: string; keepUrl?: boolean }) {
      return request<{ webhookUrl: string; secret?: string; secretSet?: boolean }>(
        `/projects/${projectId}/flows/${id}/webhook/rotate`,
        { method: 'POST', body: JSON.stringify(body ?? {}) },
      );
    },
    revealWebhook(projectId: string, id: string) {
      return request<{ webhookUrl: string; secret: string }>(`/projects/${projectId}/flows/${id}/webhook/reveal`, {
        method: 'POST',
      });
    },
  },

  blueprints: {
    analyze(input: AnalyzeBlueprintInput) {
      return request<BlueprintDetail>(`/blueprints/analyze`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    list(teamId: string) {
      return request<BlueprintSummary[]>(`/blueprints?teamId=${encodeURIComponent(teamId)}`);
    },
    get(id: string) {
      return request<BlueprintDetail>(`/blueprints/${id}`);
    },
    approve(id: string, applicationModel: ApplicationModel) {
      return request<BlueprintDetail>(`/blueprints/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({ applicationModel }),
      });
    },
    generate(id: string, projectId?: string) {
      return request<BlueprintGenerateResult>(`/blueprints/${id}/generate`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
    },
    resync(id: string, sheets: BlueprintSheet[], name?: string) {
      return request<BlueprintDetail>(`/blueprints/${id}/resync`, {
        method: 'POST',
        body: JSON.stringify({ sheets, name }),
      });
    },
    remove(id: string) {
      return request<{ deleted: boolean }>(`/blueprints/${id}`, { method: 'DELETE' });
    },
  },

  migrations: {
    plan(blueprintId: string) {
      return request<MigrationRun>(`/blueprints/${blueprintId}/migrations/plan`, {
        method: 'POST',
      });
    },
    list(blueprintId: string) {
      return request<MigrationRun[]>(`/blueprints/${blueprintId}/migrations`);
    },
    get(runId: string) {
      return request<MigrationRun>(`/migrations/${runId}`);
    },
    apply(runId: string, force = false) {
      return request<MigrationRun>(`/migrations/${runId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
    },
  },

  apiTokens: {
    scopes() {
      return request<ApiTokenScopeGroup[]>(`/account/api-tokens/scopes`);
    },
    list() {
      return request<ApiToken[]>(`/account/api-tokens`);
    },
    create(data: CreateApiTokenInput) {
      return request<CreatedApiToken>(`/account/api-tokens`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update(id: string, data: { name?: string; scopes?: string[]; expiresAt?: string | null }) {
      return request<ApiToken>(`/account/api-tokens/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    roll(id: string) {
      return request<CreatedApiToken>(`/account/api-tokens/${id}/roll`, { method: 'POST' });
    },
    revoke(id: string) {
      return request<{ revoked: boolean }>(`/account/api-tokens/${id}`, { method: 'DELETE' });
    },
    /** Permanently delete a revoked token (an active one is refused). */
    remove(id: string) {
      return request<{ deleted: boolean }>(`/account/api-tokens/${id}/permanent`, { method: 'DELETE' });
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
      opts?: {
        page?: number;
        limit?: number;
        countTotal?: boolean;
        /** Run in a read-only transaction (used when re-running to fetch a page). */
        readOnly?: boolean;
        /** Cap on rows of statements that cannot be paged (scripts, writes). */
        maxRows?: number;
        /** Skip `resultSets` when it would repeat `rows`. */
        compact?: boolean;
        /** Id for POST /sql/cancel. */
        runId?: string;
        signal?: AbortSignal;
      },
    ) {
      return request<SqlResult>('/sql/execute', {
        method: 'POST',
        signal: opts?.signal,
        body: JSON.stringify({
          projectId,
          query,
          page: opts?.page,
          limit: opts?.limit,
          countTotal: opts?.countTotal,
          readOnly: opts?.readOnly,
          maxRows: opts?.maxRows,
          compact: opts?.compact,
          runId: opts?.runId,
        }),
      });
    },
    /** Cancel a statement this user started with `runId`. */
    cancel(projectId: string, runId: string) {
      return request<{ cancelled: boolean }>('/sql/cancel', {
        method: 'POST',
        body: JSON.stringify({ projectId, runId }),
      });
    },
    /** The signed-in user's recent statements in this project. */
    history(projectId: string, limit = 50) {
      return request<SqlHistoryEntry[]>(
        `/sql/history?projectId=${encodeURIComponent(projectId)}&limit=${limit}`,
      );
    },
    listSnippets(projectId: string) {
      return request<SqlSnippet[]>(`/sql/snippets?projectId=${encodeURIComponent(projectId)}`);
    },
    createSnippet(projectId: string, data: { name: string; query: string }) {
      return request<SqlSnippet>('/sql/snippets', {
        method: 'POST',
        body: JSON.stringify({ projectId, ...data }),
      });
    },
    updateSnippet(id: string, data: { name?: string; query?: string }) {
      return request<SqlSnippet>(`/sql/snippets/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    deleteSnippet(id: string) {
      return request<{ deleted: boolean }>(`/sql/snippets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
  },

  dataQuery: {
    executeJs(
      projectId: string,
      source: string,
      opts?: { page?: number; limit?: number },
    ) {
      return request<DataQueryResult>(`/v1/projects/${projectId}/data-query/js`, {
        method: 'POST',
        body: JSON.stringify({
          source,
          page: opts?.page,
          limit: opts?.limit,
        }),
      });
    },
    executeAggregation(projectId: string, entity: string, pipeline: unknown[]) {
      return request<DataQueryResult>(`/v1/projects/${projectId}/data-query/aggregation`, {
        method: 'POST',
        body: JSON.stringify({ entity, pipeline }),
      });
    },
    capabilities(projectId: string) {
      return request<DataQueryCapabilities>(`/v1/projects/${projectId}/data-query/capabilities`);
    },
    listSaved(projectId: string) {
      return request<SavedDataQueryItem[]>(`/v1/projects/${projectId}/data-query/saved`);
    },
    saveQuery(
      projectId: string,
      data: { name: string; source: string; entity?: string; mode?: 'js' | 'aggregation' },
    ) {
      return request<SavedDataQueryItem>(`/v1/projects/${projectId}/data-query/saved`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteSaved(projectId: string, id: string) {
      return request<{ message: string }>(`/v1/projects/${projectId}/data-query/saved/${id}`, {
        method: 'DELETE',
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
      appVersion?: string;
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
          editedAt?: string | null;
        }[];
        type: string;
        status: string;
        appVersion?: string | null;
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
    updateComment(id: string, commentId: string, comment: string) {
      return request<{
        id: string;
        comment: string;
        editedAt?: string | null;
      }>(`/feedback/${id}/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ comment }),
      });
    },
    removeComment(id: string, commentId: string) {
      return request<{ success: boolean }>(`/feedback/${id}/comments/${commentId}`, {
        method: 'DELETE',
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
    /** The dashboard says "delete this bucket and all its files", so it always forces. */
    deleteBucket(projectId: string, bucketName: string) {
      return request<{ message: string }>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}?force=true`,
        { method: 'DELETE' },
      );
    },
    updateBucket(projectId: string, bucketName: string, isPublic: boolean) {
      return request<{ public: boolean }>(`/projects/${projectId}/storage/buckets/${bucketName}`, {
        method: 'PATCH',
        body: JSON.stringify({ public: isPublic }),
      });
    },
    /** Per-bucket upload limits; null clears a limit, an empty list accepts any type. */
    updateBucketLimits(
      projectId: string,
      bucketName: string,
      limits: { fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
    ) {
      return request<{ fileSizeLimit: number | null; allowedMimeTypes: string[] }>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}`,
        { method: 'PATCH', body: JSON.stringify(limits) },
      );
    },
    listObjects(
      projectId: string,
      bucketName: string,
      prefix = '',
      opts: { search?: string; recursive?: boolean } = {},
    ) {
      const q = new URLSearchParams();
      if (prefix) q.set('prefix', prefix);
      if (opts.search) q.set('search', opts.search);
      if (opts.recursive) q.set('recursive', 'true');
      const qs = q.toString();
      return request<StorageObject[]>(`/projects/${projectId}/storage/buckets/${bucketName}/objects${qs ? `?${qs}` : ''}`);
    },
    copyObject(projectId: string, bucketName: string, from: string, to: string, overwrite = false) {
      return request<{ from: string; to: string; copied: number }>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/objects/copy`,
        { method: 'POST', body: JSON.stringify({ from, to, overwrite }) },
      );
    },
    renameObject(projectId: string, bucketName: string, from: string, to: string, overwrite = false) {
      return request<{ from: string; to: string; moved: number }>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/objects/rename`,
        { method: 'POST', body: JSON.stringify({ from, to, overwrite }) },
      );
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
    createFolder(projectId: string, bucketName: string, path: string) {
      return request<{ name: string }>(`/projects/${projectId}/storage/buckets/${bucketName}/folders`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
    },
    publicUrl(projectId: string, bucketName: string, path = '') {
      const p = path ? `?path=${encodeURIComponent(path)}` : '';
      return request<{ public: boolean; url: string | null }>(
        `/projects/${projectId}/storage/buckets/${bucketName}/public-url${p}`,
      );
    },
    findExisting(projectId: string, bucketName: string, paths: string[]) {
      return request<{ existing: string[] }>(
        `/projects/${projectId}/storage/buckets/${bucketName}/objects/exists`,
        { method: 'POST', body: JSON.stringify({ paths }) },
      );
    },
    moveObjects(projectId: string, bucketName: string, sources: string[], destFolder: string) {
      return request<{ moved: number }>(
        `/projects/${projectId}/storage/buckets/${bucketName}/objects/move`,
        { method: 'POST', body: JSON.stringify({ sources, destFolder }) },
      );
    },
    getPolicies(projectId: string) {
      return request<import('./types').StoragePolicy[]>(`/projects/${projectId}/storage/policies`);
    },
    setPolicy(projectId: string, bucketName: string, mode: import('./types').StoragePolicyMode, pathPrefix = '') {
      return request<import('./types').StoragePolicy>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/policy`,
        { method: 'PUT', body: JSON.stringify({ mode, pathPrefix }) },
      );
    },
    removePolicy(projectId: string, bucketName: string, pathPrefix = '') {
      return request<{ removed: number }>(
        `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/policy?pathPrefix=${encodeURIComponent(pathPrefix)}`,
        { method: 'DELETE' },
      );
    },
    /**
     * Large files go up in chunks through a resumable session, so no single
     * request has to carry the whole file through the proxy. A failed chunk is
     * retried after re-reading the server's offset.
     */
    async uploadResumable(
      projectId: string,
      bucketName: string,
      path: string,
      file: File,
      onProgress?: (progress: import('./types').UploadProgress) => void,
    ) {
      type Session = { id: string; offset: number; size: number; chunkSize: number };
      const sessions = `/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/upload-sessions`;
      const session = await request<Session>(sessions, {
        method: 'POST',
        body: JSON.stringify({ path, size: file.size, contentType: file.type || undefined }),
      });
      const report = (uploaded: number) =>
        onProgress?.({ uploaded, total: file.size, percent: file.size === 0 ? 100 : Math.floor((uploaded / file.size) * 100) });

      let offset = session.offset;
      let failures = 0;
      report(offset);
      while (offset < file.size) {
        const slice = file.slice(offset, Math.min(offset + session.chunkSize, file.size));
        const token = getAccessToken();
        const res = await fetch(`/api/proxy${sessions}/${session.id}`, {
          method: 'PATCH',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: slice,
        });
        if (res.ok) {
          const body = await parseOkJsonBody<{ offset?: number }>(res);
          offset = typeof body?.offset === 'number' && body.offset > offset ? body.offset : offset + slice.size;
          failures = 0;
        } else if ((res.status === 409 || res.status >= 500) && failures < 3) {
          failures++;
          await new Promise((r) => setTimeout(r, 500 * 2 ** (failures - 1)));
          const fresh = await request<Session>(`${sessions}/${session.id}`);
          offset = fresh.offset;
        } else {
          const body = await res.json().catch(() => ({} as { message?: string }));
          throw new Error(body.message || `Upload failed: ${res.status}`);
        }
        report(offset);
      }
      return request<StorageObject>(`${sessions}/${session.id}/complete`, { method: 'POST' });
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
    /** Run a read-only SQL block (422 AI_SQL_NEEDS_APPROVAL for anything that changes data). */
    runSql(projectId: string, sql: string) {
      return request<{ results: import('./ai-assistant').AiStatementResult[] }>('/ai/sql/run', {
        method: 'POST',
        body: JSON.stringify({ projectId, sql }),
      });
    },
    /** Validate a SQL block that changes something and hold it for approval. */
    propose(projectId: string, sql: string) {
      return request<import('./ai-assistant').AiProposalEvent>('/ai/proposals', {
        method: 'POST',
        body: JSON.stringify({ projectId, sql }),
      });
    },
    approve(proposalId: string) {
      return request<import('./ai-assistant').AiApplyResult>(
        `/ai/proposals/${encodeURIComponent(proposalId)}/approve`,
        { method: 'POST' },
      );
    },
    reject(proposalId: string) {
      return request<{ rejected: boolean }>(`/ai/proposals/${encodeURIComponent(proposalId)}`, {
        method: 'DELETE',
      });
    },
    /** The project's own model and key for the assistant (the key itself is never returned). */
    getSettings(projectId: string) {
      return request<import('./ai-assistant').AiAssistantSettings>(`/projects/${projectId}/ai/assistant`);
    },
    saveSettings(
      projectId: string,
      body: { provider: string; model?: string; apiKey?: string; skipValidation?: boolean },
    ) {
      return request<{ settings: import('./ai-assistant').AiAssistantSettings; warning: string | null }>(
        `/projects/${projectId}/ai/assistant`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },
    clearSettings(projectId: string) {
      return request<import('./ai-assistant').AiAssistantSettings>(`/projects/${projectId}/ai/assistant`, {
        method: 'DELETE',
      });
    },
  },

  /**
   * Assistant history, stored per signed-in person rather than per browser.
   * Every route takes the user from the token, so there is no id to pass and
   * no way to ask for someone else's conversation.
   */
  aiChat: {
    listSessions(teamId: string) {
      return request<
        {
          id: string;
          title: string | null;
          projectId: string | null;
          createdAt: string;
          updatedAt: string;
          messageCount: number;
        }[]
      >(`/ai/chat/sessions?teamId=${encodeURIComponent(teamId)}`);
    },
    getSession(id: string) {
      return request<{
        id: string;
        title: string | null;
        messages: { id: string; role: string; content: string; meta?: unknown; createdAt: string }[];
      }>(`/ai/chat/sessions/${encodeURIComponent(id)}`);
    },
    createSession(teamId: string, projectId?: string, title?: string) {
      return request<{ id: string; title: string | null }>('/ai/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ teamId, projectId, title }),
      });
    },
    appendMessages(id: string, messages: { role: string; content: string; meta?: unknown }[]) {
      return request<{ appended: number }>(
        `/ai/chat/sessions/${encodeURIComponent(id)}/messages`,
        { method: 'POST', body: JSON.stringify({ messages }) },
      );
    },
    deleteSession(id: string) {
      return request<{ deleted: boolean }>(`/ai/chat/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
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
    async downloadInvoicePdf(teamId: string, invoiceId: string, type: 'invoice' | 'receipt' = 'invoice'): Promise<Blob> {
      const token = getAccessToken();
      const res = await fetch(
        `/api/proxy/billing/invoices/${invoiceId}/pdf?teamId=${encodeURIComponent(teamId)}&type=${type}`,
        { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      );
      if (!res.ok) throw new Error(`Failed to download ${type}`);
      return res.blob();
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
    quickbooksStatus() {
      return request<{
        configured: boolean; connected: boolean; companyName: string | null;
        realmId: string | null; environment: string; autoCreate: boolean;
        connectedAt: string | null; redirectUri: string | null;
      }>('/admin/quickbooks/status');
    },
    quickbooksAuthorizeUrl() {
      return request<{ url: string }>('/admin/quickbooks/authorize-url');
    },
    quickbooksDashboard() {
      return request<any>('/admin/quickbooks/dashboard');
    },
    quickbooksTest() {
      return request<{ id: string; docNumber: string | null; url: string | null; amount: number }>(
        '/admin/quickbooks/test',
        { method: 'POST' },
      );
    },
    quickbooksSetAutoCreate(autoCreate: boolean) {
      return request<{ autoCreate: boolean }>('/admin/quickbooks/settings', {
        method: 'PATCH', body: JSON.stringify({ autoCreate }),
      });
    },
    quickbooksDisconnect() {
      return request<{ connected: boolean }>('/admin/quickbooks/disconnect', { method: 'POST' });
    },
    requestStudentOtp(teamId: string, email: string) {
      return request<{ otpSent: boolean; message: string }>(
        '/billing/student-verification/request',
        { method: 'POST', body: JSON.stringify({ teamId, email }) },
      );
    },
    confirmStudentOtp(teamId: string, email: string, code: string) {
      return request<{ verified: boolean; discountPercent: number; message: string }>(
        '/billing/student-verification/confirm',
        { method: 'POST', body: JSON.stringify({ teamId, email, code }) },
      );
    },
    managementDoc(slug: string) {
      return request<{ slug: string; title: string; content: string; updatedAt: string | null }>(
        `/admin/management/doc/${slug}`,
      );
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
    /** Per-project cost breakdown for the team's current billing period. */
    projectCosts(teamId: string) {
      return request<TeamCostReport>(`/billing/project-costs?teamId=${encodeURIComponent(teamId)}`);
    },
    managementProjectCosts() {
      return request<PlatformCostReport>('/billing/management/project-costs');
    },
    refreshManagementProjectCosts() {
      return request<{ projects: number }>('/billing/management/project-costs/refresh', { method: 'POST' });
    },
    managementCostConfig() {
      return request<InfraCostConfig>('/billing/management/cost-config');
    },
    updateManagementCostConfig(
      patch: Partial<Omit<InfraCostConfig, 'server'>> & { server?: Partial<InfraCostConfig['server']> },
    ) {
      return request<InfraCostConfig>('/billing/management/cost-config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    managementStripeOverview() {
      return request<any>('/billing/management/stripe-overview');
    },
    managementEmailReports() {
      return request<any>('/billing/management/email-reports');
    },
    updateManagementEmailReports(body: { schedule?: Record<string, boolean>; content?: Record<string, boolean> }) {
      return request<any>('/billing/management/email-reports', {
        method: 'PATCH',
        body: JSON.stringify(body),
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
    listAuditLogs(opts?: {
      page?: number;
      limit?: number;
      search?: string;
      severity?: string;
      success?: string;
      dateFrom?: string;
      dateTo?: string;
    }) {
      const params = new URLSearchParams();
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.search) params.set('search', opts.search);
      if (opts?.severity && opts.severity !== 'ALL') params.set('severity', opts.severity);
      if (opts?.success && opts.success !== 'ALL') params.set('success', opts.success);
      if (opts?.dateFrom) params.set('dateFrom', opts.dateFrom);
      if (opts?.dateTo) params.set('dateTo', opts.dateTo);
      const qs = params.toString();
      return request<{
        data: AuditLogEntry[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      }>(`/observability/audit-logs${qs ? `?${qs}` : ''}`);
    },
    getAuditLog(id: string) {
      return request<AuditLogEntry>(`/observability/audit-logs/${id}`);
    },
    auditSinkStatus() {
      return request<AuditSinkStatus>('/observability/audit-sink');
    },
    auditSinkTest() {
      return request<AuditSinkTestResult>('/observability/audit-sink/test', { method: 'POST' });
    },
  },

  embeddings: {
    getStatus(projectId: string) {
      return request<EmbeddingStatus>(`/projects/${projectId}/embeddings/status`);
    },
    /** Providers the project may choose from, and which platform keys exist. */
    providers(projectId: string) {
      return request<EmbeddingProviderCatalogue>(`/projects/${projectId}/embeddings/providers`);
    },
    /**
     * Switch provider / model / endpoint. Rejects with code
     * EMBEDDING_MODEL_CHANGE_REQUIRES_REEMBED until `reembed: true` confirms
     * rewriting the vectors the project already holds.
     */
    setProvider(projectId: string, body: SetEmbeddingProviderBody) {
      return request<SetEmbeddingProviderResult>(`/projects/${projectId}/embeddings/provider`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    reembed(projectId: string) {
      return request<{ queued: boolean; total: number }>(
        `/projects/${projectId}/embeddings/reembed`,
        { method: 'POST' },
      );
    },
    /** Provider, model, vector width and the country the project's text goes to. */
    disclosure(projectId: string) {
      return request<EmbeddingDisclosure>(`/projects/${projectId}/ai/disclosure`);
    },
    enable(projectId: string) {
      return request<{ message: string; projectId: string }>(
        `/projects/${projectId}/embeddings/enable`,
        { method: 'POST' },
      );
    },
    /**
     * Turn pgvector off. The stored embeddings are kept unless `dropData`,
     * which also deletes the embedding tables (409 EMBEDDING_TABLES_IN_USE when
     * the project's own objects depend on them).
     */
    disable(projectId: string, opts: { dropData?: boolean } = {}) {
      return request<{ message: string; projectId: string; dataDropped?: boolean }>(
        `/projects/${projectId}/embeddings/enable${opts.dropData ? '?dropData=true' : ''}`,
        { method: 'DELETE' },
      );
    },
    /**
     * Store (after a live test request) or clear the per-project key. Rejects
     * with code EMBEDDING_API_KEY_REJECTED, EMBEDDING_API_KEY_TEST_FAILED or
     * EMBEDDING_PROVIDER_UNREACHABLE; the last two may be retried with
     * `skipValidation`.
     */
    setApiKey(projectId: string, apiKey: string | null, opts: SetEmbeddingApiKeyOptions = {}) {
      return request<SetEmbeddingApiKeyResult>(
        `/projects/${projectId}/embeddings/api-key`,
        { method: 'POST', body: JSON.stringify({ apiKey, ...opts }) },
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
  /** Root console on admin.<domain> — every call is root-only. */
  console: {
    overview() {
      return request<ConsoleOverview>('/admin/console/overview');
    },
    projects(includeDeleted = false) {
      return request<ConsoleProjectList>(`/admin/console/projects${includeDeleted ? '?includeDeleted=true' : ''}`);
    },
    project(id: string) {
      return request<ConsoleProjectDetail>(`/admin/console/projects/${encodeURIComponent(id)}`);
    },
    storage() {
      return request<ConsoleStorage>('/admin/console/storage');
    },
    disk() {
      return request<ConsoleDisk>('/admin/console/disk');
    },
    alerts() {
      return request<ConsoleAlertFeed>('/admin/console/alerts');
    },
    acknowledgeAlert(id: string) {
      return request<{ acknowledged: number }>(`/admin/console/alerts/${encodeURIComponent(id)}/acknowledge`, {
        method: 'POST',
      });
    },
    acknowledgeAllAlerts() {
      return request<{ acknowledged: number }>('/admin/console/alerts/acknowledge-all', { method: 'POST' });
    },
    refreshStorage() {
      return request<{ started: boolean }>('/admin/console/storage/refresh', { method: 'POST' });
    },
  },
};
