import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  authorAvatar: string | null;
  date: string;
  url: string;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly baseUrl = 'https://api.github.com';

  constructor(private readonly http: HttpService) {}

  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async validateToken(token: string): Promise<{ login: string; avatarUrl: string }> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/user`, {
          headers: this.headers(token),
          timeout: 10000,
        }),
      );
      return { login: data.login, avatarUrl: data.avatar_url };
    } catch (err: any) {
      throw new BadRequestException('Invalid GitHub token');
    }
  }

  async listRepos(token: string): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    let page = 1;

    while (page <= 5) {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/user/repos`, {
          headers: this.headers(token),
          params: { per_page: 100, page, sort: 'updated', direction: 'desc' },
          timeout: 15000,
        }),
      );

      if (!Array.isArray(data) || data.length === 0) break;

      for (const r of data) {
        repos.push({
          id: r.id,
          full_name: r.full_name,
          name: r.name,
          owner: r.owner?.login || '',
          private: r.private,
          html_url: r.html_url,
          default_branch: r.default_branch,
          description: r.description,
          updated_at: r.updated_at,
        });
      }

      if (data.length < 100) break;
      page++;
    }

    return repos;
  }

  async getCommits(
    token: string,
    owner: string,
    repo: string,
    branch = 'main',
    count = 20,
  ): Promise<GitHubCommit[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/repos/${owner}/${repo}/commits`, {
          headers: this.headers(token),
          params: { sha: branch, per_page: count },
          timeout: 10000,
        }),
      );

      return (data || []).map((c: any) => ({
        sha: c.sha,
        message: c.commit?.message?.split('\n')[0] || '',
        author: c.commit?.author?.name || c.author?.login || 'unknown',
        authorAvatar: c.author?.avatar_url || null,
        date: c.commit?.author?.date || '',
        url: c.html_url,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to fetch commits: ${err.message}`);
      return [];
    }
  }

  async getBranches(token: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/repos/${owner}/${repo}/branches`, {
          headers: this.headers(token),
          params: { per_page: 100 },
          timeout: 10000,
        }),
      );

      return (data || []).map((b: any) => ({
        name: b.name,
        protected: b.protected || false,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to fetch branches: ${err.message}`);
      return [];
    }
  }
}
