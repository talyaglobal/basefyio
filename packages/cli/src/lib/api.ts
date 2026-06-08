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
