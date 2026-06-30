import { HttpClient } from '../http';
import type { CreateProjectParams, Project, UpdateProjectParams } from '../types';

export class ProjectsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<Project[]> {
    return this.http.get('/projects');
  }

  create(params: CreateProjectParams): Promise<Project> {
    return this.http.post('/projects', params);
  }

  get(id: string): Promise<Project> {
    return this.http.get(`/projects/${id}`);
  }

  update(id: string, params: UpdateProjectParams): Promise<Project> {
    return this.http.patch(`/projects/${id}`, params);
  }

  delete(id: string): Promise<void> {
    return this.http.del(`/projects/${id}`);
  }

  permanentDelete(id: string): Promise<void> {
    return this.http.del(`/projects/${id}/permanent`);
  }

  restore(id: string): Promise<Project> {
    return this.http.post(`/projects/${id}/restore`);
  }

  activity(id: string, opts: { page?: number; limit?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.page != null) params.set('page', String(opts.page));
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.http.get(`/projects/${id}/activity${qs ? `?${qs}` : ''}`);
  }
}
