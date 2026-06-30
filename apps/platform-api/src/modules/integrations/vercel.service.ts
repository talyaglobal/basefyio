import {
  Injectable,
  Logger,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  url: string | null;
  updatedAt: number;
}

export interface VercelDeployment {
  id: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  url: string | null;
  commitMessage: string | null;
  branch: string | null;
  createdAt: string;
}

@Injectable()
export class VercelService {
  private readonly logger = new Logger(VercelService.name);
  private readonly baseUrl = 'https://api.vercel.com';

  constructor(private readonly http: HttpService) {}

  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private teamParam(teamId?: string | null): Record<string, string> {
    return teamId ? { teamId } : {};
  }

  async validateToken(token: string): Promise<{ username: string }> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/v2/user`, {
          headers: this.headers(token),
          timeout: 10000,
        }),
      );
      return { username: data.user?.username || data.user?.name || 'unknown' };
    } catch (err: any) {
      throw new BadRequestException('Invalid Vercel token');
    }
  }

  async getProjectDashboardUrl(
    token: string,
    projectId: string,
    teamId?: string | null,
  ): Promise<string | null> {
    try {
      const { data: proj } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/v9/projects/${projectId}`, {
          headers: this.headers(token),
          params: { ...this.teamParam(teamId) },
          timeout: 10000,
        }),
      );

      const projectName = proj.name;
      const accountId = proj.accountId;

      if (!accountId || !projectName) return null;

      // Try team first (accountId could be a team ID)
      try {
        const { data: team } = await firstValueFrom(
          this.http.get(`${this.baseUrl}/v2/teams/${accountId}`, {
            headers: this.headers(token),
            timeout: 10000,
          }),
        );
        if (team.slug) {
          return `https://vercel.com/${team.slug}/${projectName}`;
        }
      } catch {
        // Not a team, fall through to user lookup
      }

      // Fall back to user (personal account)
      try {
        const { data: user } = await firstValueFrom(
          this.http.get(`${this.baseUrl}/v2/user`, {
            headers: this.headers(token),
            timeout: 10000,
          }),
        );
        if (user.user?.username) {
          return `https://vercel.com/${user.user.username}/${projectName}`;
        }
      } catch {}

      return null;
    } catch {
      return null;
    }
  }

  async listProjects(token: string, teamId?: string | null): Promise<VercelProject[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/v9/projects`, {
          headers: this.headers(token),
          params: { limit: 100, ...this.teamParam(teamId) },
          timeout: 15000,
        }),
      );

      return (data.projects || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        framework: p.framework || null,
        url: p.targets?.production?.url ? `https://${p.targets.production.url}` : null,
        updatedAt: p.updatedAt,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Vercel projects: ${err.message}`);
      return [];
    }
  }

  async getDeployments(
    token: string,
    projectId: string,
    teamId?: string | null,
    count = 20,
  ): Promise<VercelDeployment[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/v6/deployments`, {
          headers: this.headers(token),
          params: {
            projectId,
            limit: count,
            ...this.teamParam(teamId),
          },
          timeout: 10000,
        }),
      );

      return (data.deployments || []).map((d: any) => ({
        id: d.uid || d.id,
        state: (d.readyState || d.state || 'QUEUED').toUpperCase(),
        url: d.url ? `https://${d.url}` : null,
        commitMessage: d.meta?.githubCommitMessage || null,
        branch: d.meta?.githubCommitRef || null,
        createdAt: new Date(d.created || d.createdAt).toISOString(),
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Vercel deployments: ${err.message}`);
      return [];
    }
  }

  /** Extract a readable reason from an Axios/Vercel error. */
  private vercelErrorReason(err: any): string {
    return (
      err?.response?.data?.error?.message ||
      err?.response?.data?.error?.code ||
      err?.message ||
      'unknown error'
    );
  }

  /**
   * Create or update environment variables on a Vercel project.
   *
   * A key may already exist on Vercel as several entries split across targets
   * (the dashboard and Git integrations create them that way). We update the
   * value of every existing entry *in place* — without touching its target —
   * to avoid the `ENV_CONFLICT`/`ENV_ALREADY_EXISTS` 400 that Vercel returns
   * when a PATCH tries to widen one entry onto a target another entry owns.
   * Keys with no existing entry are created once for all three targets.
   *
   * Per-variable Vercel failures are collected and surfaced as a clear
   * BadGateway error instead of bubbling up as an opaque 500.
   */
  async upsertEnvVars(
    token: string,
    projectId: string,
    teamId: string | null | undefined,
    vars: Record<string, string>,
  ): Promise<{ created: number; updated: number }> {
    const tp = this.teamParam(teamId);
    const hdrs = this.headers(token);

    let existing: any;
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/v9/projects/${projectId}/env`, {
          headers: hdrs,
          params: tp,
          timeout: 15000,
        }),
      );
      existing = res.data;
    } catch (err: any) {
      const reason = this.vercelErrorReason(err);
      this.logger.warn(`Vercel env list failed for ${projectId}: ${reason}`);
      throw new BadGatewayException(`Vercel rejected the request: ${reason}`);
    }

    // Collect *all* entry ids per key (a key can span multiple targets).
    const idsByKey = new Map<string, string[]>();
    for (const e of existing?.envs || []) {
      const list = idsByKey.get(e.key) ?? [];
      list.push(e.id);
      idsByKey.set(e.key, list);
    }

    let created = 0;
    let updated = 0;
    const targets = ['production', 'preview', 'development'];
    const failures: string[] = [];

    for (const [key, value] of Object.entries(vars)) {
      // Never push an empty/missing value — Vercel rejects it with a 400.
      if (value === undefined || value === null || value === '') {
        failures.push(`${key} (no value available on this project)`);
        continue;
      }

      const ids = idsByKey.get(key) ?? [];

      try {
        if (ids.length > 0) {
          // Update value only; leave each entry on whatever target it owns.
          for (const envId of ids) {
            await firstValueFrom(
              this.http.patch(
                `${this.baseUrl}/v9/projects/${projectId}/env/${envId}`,
                { value },
                { headers: hdrs, params: tp, timeout: 10000 },
              ),
            );
          }
          updated++;
        } else {
          await firstValueFrom(
            this.http.post(
              `${this.baseUrl}/v10/projects/${projectId}/env`,
              { key, value, target: targets, type: 'encrypted' },
              { headers: hdrs, params: tp, timeout: 10000 },
            ),
          );
          created++;
        }
      } catch (err: any) {
        failures.push(`${key} (${this.vercelErrorReason(err)})`);
      }
    }

    this.logger.log(
      `Upserted env vars on Vercel project ${projectId}: ${created} created, ${updated} updated, ${failures.length} failed`,
    );

    if (failures.length > 0) {
      throw new BadGatewayException(
        `Vercel could not save: ${failures.join('; ')}`,
      );
    }

    return { created, updated };
  }
}
