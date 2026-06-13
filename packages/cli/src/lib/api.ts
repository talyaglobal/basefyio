import axios, { AxiosInstance, AxiosError } from 'axios';
import chalk from 'chalk';
import { getApiUrl, getAccessToken, setAccessToken, getRefreshToken, setRefreshToken, clearAuthTokens } from './config.js';

/**
 * Proactively refresh the access token if it expires within the next 60 seconds.
 * Call this before any command that requires auth so the session stays alive
 * indefinitely (until explicit `basefyio logout`).
 */
export async function ensureFreshToken(): Promise<void> {
  const token = getAccessToken();
  if (!token) return; // not logged in

  // Decode JWT exp without verification (server verifies)
  try {
    const [, payloadB64] = token.split('.');
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp === 'number') {
      const expiresInMs = payload.exp * 1000 - Date.now();
      // If token is still valid for more than 60 seconds, skip refresh
      if (expiresInMs > 60_000) return;
    }
  } catch {
    // Can't decode — try refreshing anyway
  }

  const refreshToken = getRefreshToken();
  if (!refreshToken) return;

  try {
    const { data } = await axios.post(`${getApiUrl()}/api/auth/refresh`, { refreshToken });
    if (data?.accessToken) {
      setAccessToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
    }
  } catch {
    // Silent — the 401 interceptor will handle it on the actual request
  }
}


/**
 * Carried out of the response interceptor so the calling command can decide
 * how to surface authentication failures (instead of the interceptor calling
 * process.exit(1) and giving the user no actionable diagnostics).
 */
export class AuthError extends Error {
  readonly kind: 'NOT_LOGGED_IN' | 'SESSION_EXPIRED' | 'REFRESH_TRANSIENT';
  constructor(
    kind: 'NOT_LOGGED_IN' | 'SESSION_EXPIRED' | 'REFRESH_TRANSIENT',
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.name = 'AuthError';
  }
}

export class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: getApiUrl(),
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth token to requests
    this.client.interceptors.request.use((config) => {
      const token = getAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Handle token refresh.
    //
    // Subtle pitfalls we are guarding against (see "basefyio status re-login loop"
    // incident report):
    //   * Don't call process.exit(1) from inside an interceptor — it kills
    //     the process before the calling command can present a coherent
    //     message and prevents tests from observing the failure. Throw an
    //     AuthError instead and let the command handler surface it.
    //   * Don't clear tokens on a transient refresh failure (e.g. network
    //     blip, 5xx). Only clear them when Keycloak/the platform-api has
    //     authoritatively rejected the refresh token (4xx).
    //   * Don't overwrite tokens with `undefined`. setAccessToken /
    //     setRefreshToken in config.ts now refuse non-string values so a
    //     malformed refresh response can't wipe the saved session.
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config;
        if (
          error.response?.status !== 401 ||
          !originalRequest ||
          (originalRequest as any)._retry
        ) {
          return Promise.reject(error);
        }
        (originalRequest as any)._retry = true;

        const refreshToken = getRefreshToken();
        if (!refreshToken) {
          // No refresh token saved → user really must log in.
          return Promise.reject(
            new AuthError('NOT_LOGGED_IN', 'Not logged in. Run: basefyio login'),
          );
        }

        let refreshed: { accessToken?: string; refreshToken?: string } | null = null;
        let refreshFailure: AxiosError | Error | null = null;
        try {
          const { data } = await axios.post(`${getApiUrl()}/api/auth/refresh`, {
            refreshToken,
          });
          refreshed = data;
        } catch (err) {
          refreshFailure = err as AxiosError | Error;
        }

        if (refreshed?.accessToken) {
          setAccessToken(refreshed.accessToken);
          // Keycloak rotates refresh tokens by default but some configs reuse
          // the same value or omit it. Only persist if the server gave us a
          // new one; setRefreshToken in config.ts ignores undefined anyway.
          if (refreshed.refreshToken) setRefreshToken(refreshed.refreshToken);

          originalRequest.headers!.Authorization = `Bearer ${refreshed.accessToken}`;
          return this.client(originalRequest);
        }

        // Refresh failed. Distinguish authoritative rejection (token revoked /
        // expired) from transient failures (network, 5xx). Only the former
        // should wipe credentials.
        const refreshAxiosErr =
          refreshFailure && axios.isAxiosError(refreshFailure)
            ? (refreshFailure as AxiosError)
            : null;
        const refreshStatus = refreshAxiosErr?.response?.status;
        const refreshBody = refreshAxiosErr?.response?.data as any;
        const refreshMessage =
          refreshBody?.message ||
          refreshBody?.error ||
          refreshAxiosErr?.message ||
          (refreshFailure as Error | null)?.message ||
          'Refresh failed';

        if (refreshStatus && refreshStatus >= 400 && refreshStatus < 500) {
          clearAuthTokens();
          return Promise.reject(
            new AuthError(
              'SESSION_EXPIRED',
              `Session expired (${refreshStatus}: ${refreshMessage}). Run: basefyio login`,
            ),
          );
        }

        // Transient — don't wipe tokens, let the user retry.
        return Promise.reject(
          new AuthError(
            'REFRESH_TRANSIENT',
            `Could not refresh session (${refreshMessage}). Check your network and try again; if the problem persists, run: basefyio login`,
          ),
        );
      },
    );
  }

  // Auth endpoints
  async login(email: string, password: string) {
    const { data } = await this.client.post('/api/auth/login', { email, password });
    return data;
  }

  /** Create CLI login state on the server and return the state ID. */
  async cliLoginState(port: number, nonce: string) {
    const { data } = await this.client.post('/api/auth/cli-login-state', { port, nonce });
    return data as { cliState: string; authorizeUrl: string };
  }

  /** Exchange the one-time CLI login code for real tokens. */
  async cliExchange(code: string, nonce: string) {
    const { data } = await this.client.post('/api/auth/cli/exchange', { code, nonce });
    return data as { accessToken: string; refreshToken: string; idToken?: string; expiresIn: number; tokenType: string };
  }

  /** Fetch the current user's JWT payload to extract email after CLI login. */
  async getMe() {
    const { data } = await this.client.get('/api/auth/me');
    return data as { email: string; sub: string; given_name?: string; family_name?: string };
  }

  async signup(userData: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) {
    const { data } = await this.client.post('/api/auth/signup', userData);
    return data;
  }

  // Projects endpoints
  async getProjects(teamId: string) {
    const { data } = await this.client.get('/api/projects', {
      params: { teamId },
    });
    return data;
  }

  async getProject(projectId: string) {
    const { data } = await this.client.get(`/api/projects/${projectId}`);
    return data;
  }

  /** Pooler + direct Postgres URIs (same shape as Admin UI Raw Editor). */
  async getProjectConnect(projectId: string) {
    const { data } = await this.client.get(`/api/projects/${projectId}/connect`);
    return data as {
      uri: string;
      poolerUri: string;
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      poolerHost: string;
      poolerPort: number;
      restUrl: string;
      publicBaseUrl: string;
      keycloakRealm: string;
      keycloakUrl: string;
      anonKey: string;
      serviceKey: string;
    };
  }

  async createProject(projectData: {
    name: string;
    description?: string;
    teamId: string;
  }) {
    const { data } = await this.client.post('/api/projects', projectData);
    return data;
  }

  async deleteProject(projectId: string) {
    const { data } = await this.client.delete(`/api/projects/${projectId}`);
    return data;
  }

  // SQL endpoints
  async executeSQL(projectId: string, query: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const { data } = await this.client.post('/api/sql/execute', {
      projectId,
      query,
    });
    return data;
  }

  // Teams endpoints
  async getTeams() {
    const { data } = await this.client.get('/api/teams');
    return data;
  }

  async getActiveTeam() {
    const { data } = await this.client.get('/api/teams/active');
    return data;
  }

  // Project data endpoints
  async getTables(projectId: string) {
    const { data } = await this.client.get(`/api/projects/${projectId}/data/tables`);
    return data;
  }

  async getTableSchema(projectId: string, tableName: string) {
    const { data } = await this.client.get(`/api/projects/${projectId}/data/tables/${tableName}/schema`);
    return data;
  }

  async getTableData(projectId: string, tableName: string, options?: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    order?: 'asc' | 'desc';
  }) {
    const { data } = await this.client.get(`/api/projects/${projectId}/data/tables/${tableName}/rows`, {
      params: options,
    });
    return data;
  }

  // Provisioning — operations
  async listProvisioningOperations(projectId: string, opts: { status?: string; limit?: number } = {}) {
    const { data } = await this.client.get('/api/v1/provisioning/operations', {
      params: { projectId, ...opts },
    });
    return data as any[];
  }

  async getProvisioningOperation(operationId: string) {
    const { data } = await this.client.get(`/api/v1/provisioning/operations/${operationId}`);
    return data as any;
  }

  async cancelProvisioningOperation(operationId: string) {
    const { data } = await this.client.post(`/api/v1/provisioning/operations/${operationId}/cancel`);
    return data as any;
  }

  async retryProvisioningOperation(operationId: string) {
    const { data } = await this.client.post(`/api/v1/provisioning/operations/${operationId}/retry`);
    return data as any;
  }

  async getProvisioningOperationEvents(operationId: string, opts: { limit?: number; cursor?: string } = {}) {
    const params: Record<string, any> = {};
    if (opts.limit != null) params.limit = opts.limit;
    if (opts.cursor) params.cursor = opts.cursor;
    const { data } = await this.client.get(
      `/api/v1/provisioning/operations/${encodeURIComponent(operationId)}/events`,
      { params },
    );
    return data as { events: any[]; nextCursor: string | null };
  }

  // Provisioning — resources
  async listProvisioningResources(
    projectId: string,
    opts: { status?: string; provider?: string; limit?: number; cursor?: string } = {},
  ) {
    const params: Record<string, any> = { projectId };
    if (opts.status) params.status = opts.status;
    if (opts.provider) params.provider = opts.provider;
    if (opts.limit != null) params.limit = opts.limit;
    if (opts.cursor) params.cursor = opts.cursor;
    const { data } = await this.client.get(
      `/api/v1/provisioning/projects/${encodeURIComponent(projectId)}/resources`,
      { params },
    );
    return data as { items: any[]; nextCursor: string | null };
  }

  async getProvisioningResource(resourceId: string) {
    const { data } = await this.client.get(
      `/api/v1/provisioning/resources/${encodeURIComponent(resourceId)}`,
    );
    return data as any;
  }

  // Provisioning — provider health

  async getProviderHealth(providerName: string) {
    const { data } = await this.client.get(
      `/api/v1/provisioning/providers/${encodeURIComponent(providerName)}/health`,
    );
    return data as { name: string; healthy: boolean; latencyMs: number | null; checkedAt: string };
  }

  async getAllProviderHealth() {
    const { data } = await this.client.get('/api/v1/provisioning/providers/health');
    return data as {
      providers: Array<{ name: string; healthy: boolean; latencyMs: number | null; checkedAt: string }>;
      checkedAt: string;
    };
  }

  // Provisioning — credential refs
  async createProvisioningCredentialRef(body: { teamId: string; label: string; openbaoPath: string; provider?: string }) {
    const { data } = await this.client.post('/api/v1/provisioning/credentials', body);
    return data as any;
  }

  async listProvisioningCredentialRefs(teamId: string) {
    const { data } = await this.client.get('/api/v1/provisioning/credentials', { params: { teamId } });
    return data as any[];
  }

  async revokeProvisioningCredentialRef(credentialRefId: string) {
    await this.client.delete(`/api/v1/provisioning/credentials/${credentialRefId}`);
  }

  // Structure Items (DataStructure-based content layer)

  async listItems(
    projectId: string,
    structureId: string,
    opts: { limit?: number; cursor?: string } = {},
  ) {
    const params: Record<string, any> = {};
    if (opts.limit != null) params.limit = opts.limit;
    if (opts.cursor) params.cursor = opts.cursor;
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items`,
      { params },
    );
    return data as { data: any[]; nextCursor: string | null; total: number };
  }

  async getItem(projectId: string, structureId: string, id: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(id)}`,
    );
    return data as Record<string, unknown>;
  }

  async createItem(
    projectId: string,
    structureId: string,
    payload: Record<string, unknown>,
  ) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items`,
      payload,
    );
    return data as Record<string, unknown>;
  }

  async updateItem(
    projectId: string,
    structureId: string,
    id: string,
    payload: Record<string, unknown>,
  ) {
    const { data } = await this.client.patch(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(id)}`,
      payload,
    );
    return data as Record<string, unknown>;
  }

  async deleteItem(projectId: string, structureId: string, id: string) {
    const { data } = await this.client.delete(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}/items/${encodeURIComponent(id)}`,
    );
    return data as { deleted: boolean; id: string };
  }

  async planMigration(projectId: string, opts: { fromVersion?: number; toVersion?: number } = {}) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migrations/plan`,
      opts,
    );
    return data as {
      migrationRunId: string;
      fromVersion: number;
      toVersion: number;
      plan: {
        operations: Array<{ type: string; safety: string; collection: string; field?: string; detail: string }>;
        warnings: string[];
        breakingChanges: string[];
        hasDestructive: boolean;
      };
      sqlStatements: string[];
    };
  }

  async applyMigration(projectId: string, migrationRunId: string, force = false) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migrations/apply`,
      { migrationRunId, force },
    );
    return data as { migrationRunId: string; status: string; appliedStatements: number; errorMessage?: string };
  }

  async listMigrations(projectId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migrations`,
    );
    return data as Array<{
      id: string;
      fromBlueprintVersion: number;
      toBlueprintVersion: number;
      status: string;
      appliedStatements: number;
      createdAt: string;
    }>;
  }

  // Structures (data model layer)

  async listStructures(projectId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures`,
    );
    return data as Array<{
      id: string;
      projectId: string;
      name: string;
      kind: 'relational' | 'json';
      badge: 'SQL' | 'JSON';
      editorMode: 'sql' | 'js-query';
      dataEditorMode: 'row' | 'document';
      aiRecommended: boolean;
      aiReasons: unknown | null;
      createdAt: string;
      updatedAt: string;
    }>;
  }

  async getStructure(projectId: string, structureId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}`,
    );
    return data as {
      id: string;
      projectId: string;
      name: string;
      kind: 'relational' | 'json';
      badge: 'SQL' | 'JSON';
      editorMode: 'sql' | 'js-query';
      dataEditorMode: 'row' | 'document';
      aiRecommended: boolean;
      aiReasons: unknown | null;
      createdAt: string;
      updatedAt: string;
    };
  }

  async createStructure(projectId: string, name: string, kind: 'relational' | 'json') {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures`,
      { name, kind },
    );
    return data as {
      id: string;
      projectId: string;
      name: string;
      kind: 'relational' | 'json';
      badge: 'SQL' | 'JSON';
      editorMode: 'sql' | 'js-query';
      dataEditorMode: 'row' | 'document';
      aiRecommended: boolean;
      aiReasons: unknown | null;
      createdAt: string;
      updatedAt: string;
    };
  }

  async deleteStructure(projectId: string, structureId: string): Promise<void> {
    await this.client.delete(
      `/api/v1/projects/${encodeURIComponent(projectId)}/structures/${encodeURIComponent(structureId)}`,
    );
  }

  // Migration Archives

  async createMigrationArchive(
    projectId: string,
    input: { source: string; region: string; retention?: string },
  ) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives`,
      input,
    );
    return data;
  }

  async getMigrationArchive(projectId: string, archiveId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}`,
    );
    return data;
  }

  async listArchiveFiles(projectId: string, archiveId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files`,
    );
    return data;
  }

  async initiateFileUpload(
    projectId: string,
    archiveId: string,
    input: { filename: string; sizeBytes: number; contentType?: string; chunkSize?: number },
  ) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files`,
      input,
    );
    return data;
  }

  async updateFileProgress(
    projectId: string,
    archiveId: string,
    fileId: string,
    uploadedBytes: number,
  ) {
    const { data } = await this.client.patch(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files/${encodeURIComponent(fileId)}/progress`,
      { uploadedBytes },
    );
    return data;
  }

  async completeFileUpload(
    projectId: string,
    archiveId: string,
    fileId: string,
    checksum?: string,
  ) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/files/${encodeURIComponent(fileId)}/complete`,
      checksum !== undefined ? { checksum } : {},
    );
    return data;
  }

  async recordConsent(projectId: string, archiveId: string, input: object) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/consent`,
      input,
    );
    return data;
  }

  async deleteMigrationArchive(projectId: string, archiveId: string) {
    const { data } = await this.client.delete(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}`,
    );
    return data;
  }

  // Assessments

  async createAssessment(projectId: string, archiveId: string) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/archives/${encodeURIComponent(archiveId)}/assessments`,
      {},
    );
    return data as any;
  }

  async listAssessments(projectId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/assessments`,
    );
    return data as any;
  }

  async getAssessment(projectId: string, reportId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}`,
    );
    return data as any;
  }

  async getAssessmentVersions(projectId: string, reportId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}/versions`,
    );
    return data as any;
  }

  async exportAssessmentPdf(projectId: string, reportId: string, versionId?: string) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/migration/assessments/${encodeURIComponent(reportId)}/export-pdf`,
      versionId !== undefined ? { versionId } : {},
    );
    return data as any;
  }

  // Developer access
  async getProjectAccess(projectId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/access`,
    );
    return data as {
      projectId: string;
      slug: string;
      endpoints: Array<{
        engineType: string; host: string; port: number; username: string;
        database: string; requiresClientCert: boolean; accessLevel: string;
        active: boolean; connectionString: string; sslMode: string;
        snippets: { psql?: string; dbeaver?: string; compass?: string; sdkExample?: string };
      }>;
      entitlements: Record<string, boolean>;
      warning?: string;
    };
  }

  // Gateway

  async gatewayConnect(projectId: string, certId: string) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/gateway/connect`,
      { certId },
    );
    return data as {
      certId: string;
      accessLevel: 'READ' | 'READ_WRITE';
      policy: {
        requireMtls: boolean;
        allowedAccess: string;
        maxConnections: number;
        queryTimeoutMs: number;
        maxRowLimit: number;
        maxPayloadBytes: number;
        providerType: string;
      };
      status: 'connected';
    };
  }

  async gatewayQuery(
    projectId: string,
    certId: string,
    sql: string,
    params?: unknown[],
  ) {
    const { data } = await this.client.post(
      `/api/v1/projects/${encodeURIComponent(projectId)}/gateway/query`,
      { certId, sql, params },
    );
    return data as { rows: Record<string, unknown>[]; rowCount: number; truncated?: boolean };
  }

  async gatewayPolicy(projectId: string) {
    const { data } = await this.client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/gateway/policy`,
    );
    return data as {
      requireMtls: boolean;
      allowedAccess: string;
      maxConnections: number;
      queryTimeoutMs: number;
      maxRowLimit: number;
      maxPayloadBytes: number;
      providerType: string;
    };
  }

  async gatewayHealth() {
    const { data } = await this.client.get('/api/v1/secure-gateway/health/openbao');
    return data as {
      status: 'healthy' | 'degraded' | 'unavailable';
      checkedAt: string;
      components: {
        system: { status: string; detail?: string; hint?: string };
        pkiMount: { status: string; detail?: string; hint?: string };
        kvMount: { status: string; detail?: string; hint?: string };
      };
    };
  }
}

export const apiClient = new ApiClient();

export async function handleApiError(error: any): Promise<never> {
  if (error instanceof AuthError) {
    if (error.kind === 'SESSION_EXPIRED' || error.kind === 'NOT_LOGGED_IN') {
      // Auto re-login: clear stale tokens, run the login flow, then tell the
      // user to re-run the command instead of showing a dead-end error.
      console.error(chalk.yellow('Session expired — launching login…'));
      clearAuthTokens();
      try {
        const { loginCommand } = await import('../commands/login.js');
        await loginCommand({});
        console.log();
        console.log(chalk.green('Re-authenticated! Please re-run your command.'));
      } catch {
        console.error(chalk.red('Automatic re-login failed. Run: basefyio login'));
      }
      process.exit(1);
    }
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  if (axios.isAxiosError(error)) {
    if (error.response) {
      const message =
        error.response.data?.message || error.response.data?.error || error.message;
      console.error(chalk.red(`API Error: ${message}`));

      if (error.response.status === 401) {
        console.error(chalk.yellow('Session expired — launching login…'));
        clearAuthTokens();
        try {
          const { loginCommand } = await import('../commands/login.js');
          await loginCommand({});
          console.log();
          console.log(chalk.green('Re-authenticated! Please re-run your command.'));
        } catch {
          console.error(chalk.red('Automatic re-login failed. Run: basefyio login'));
        }
        process.exit(1);
      }
    } else if (error.request) {
      console.error(chalk.red('Network error: Could not connect to basefyio API'));
      console.error(chalk.yellow(`Make sure the API is running at: ${getApiUrl()}`));
    } else {
      console.error(chalk.red(`Error: ${error.message}`));
    }
  } else {
    console.error(chalk.red(`Error: ${error.message || error}`));
  }

  process.exit(1);
}
