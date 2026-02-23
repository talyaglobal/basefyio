import axios, { AxiosInstance, AxiosError } from 'axios';
import chalk from 'chalk';
import { getApiUrl, getAccessToken, setAccessToken, getRefreshToken, setRefreshToken } from './config.js';

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

    // Handle token refresh
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config;
        
        if (error.response?.status === 401 && originalRequest && !(originalRequest as any)._retry) {
          (originalRequest as any)._retry = true;
          
          try {
            const refreshToken = getRefreshToken();
            if (!refreshToken) {
              throw new Error('No refresh token available');
            }

            const { data } = await axios.post(`${getApiUrl()}/api/auth/refresh`, {
              refreshToken,
            });

            setAccessToken(data.accessToken);
            setRefreshToken(data.refreshToken);

            originalRequest.headers!.Authorization = `Bearer ${data.accessToken}`;
            return this.client(originalRequest);
          } catch (refreshError) {
            console.error(chalk.red('Session expired. Please login again with: kb login'));
            process.exit(1);
          }
        }

        return Promise.reject(error);
      }
    );
  }

  // Auth endpoints
  async login(username: string, password: string) {
    const { data } = await this.client.post('/api/auth/login', { username, password });
    return data;
  }

  async signup(userData: {
    username: string;
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
  async executeSQL(projectId: string, query: string) {
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

export function handleApiError(error: any) {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const message = error.response.data?.message || error.response.data?.error || error.message;
      console.error(chalk.red(`API Error: ${message}`));
      
      if (error.response.status === 401) {
        console.error(chalk.yellow('Please login first with: kb login'));
      }
    } else if (error.request) {
      console.error(chalk.red('Network error: Could not connect to Kolaybase API'));
      console.error(chalk.yellow(`Make sure the API is running at: ${getApiUrl()}`));
    } else {
      console.error(chalk.red(`Error: ${error.message}`));
    }
  } else {
    console.error(chalk.red(`Error: ${error.message || error}`));
  }
  
  process.exit(1);
}
