import { Injectable, BadRequestException } from '@nestjs/common';
import { ItemsService } from '../items/items.service';

export type SupabaseOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is';

export interface ParsedFilter {
  column: string;
  operator: SupabaseOperator;
  value: string;
}

/**
 * Parse Supabase-style filter from query params.
 * e.g. ?status=eq.active  ?name=ilike.*alice*  ?age=gte.18
 */
export function parseSupabaseFilter(query: Record<string, string>): Record<string, string> {
  const filters: Record<string, string> = {};
  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'count', 'columns']);

  for (const [key, val] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    if (typeof val !== 'string') continue;

    // Format: column=operator.value
    const dotIdx = val.indexOf('.');
    if (dotIdx < 0) continue;

    const operator = val.slice(0, dotIdx) as SupabaseOperator;
    const value = val.slice(dotIdx + 1);

    // In V1: only support eq filters (map to ItemsService filters)
    if (operator === 'eq') {
      filters[key] = value;
    }
    // Other operators (neq, gt, etc.) are logged but not enforced in V1
  }

  return filters;
}

/**
 * Parse Supabase order param.
 * e.g. ?order=created_at.desc.nullslast → { sort: 'created_at', order: 'desc' }
 */
export function parseSupabaseOrder(orderParam?: string): { sort?: string; order?: 'asc' | 'desc' } {
  if (!orderParam) return {};
  const parts = orderParam.split('.');
  const sort = parts[0];
  const order = parts[1] === 'desc' ? 'desc' : 'asc';
  return { sort, order };
}

@Injectable()
export class SupabaseCompatService {
  constructor(private readonly itemsService: ItemsService) {}

  async select(
    projectId: string,
    table: string,
    query: Record<string, string>,
  ): Promise<unknown[]> {
    const filters = parseSupabaseFilter(query);
    const { sort, order } = parseSupabaseOrder(query['order']);
    const limit = query['limit'] ? parseInt(query['limit'], 10) : 20;

    // offset → cursor approximation (V1: just pass offset as is, not real cursor)
    // For compatibility, ignore offset in V1 (pagination via cursor in Sprint 10)

    const page = await this.itemsService.listItems(projectId, table, {
      filters,
      sort,
      order,
      limit,
    });

    return page.data;
  }

  async insert(
    projectId: string,
    table: string,
    body: unknown,
  ): Promise<unknown[]> {
    // Supabase supports both single object and array
    const rows = Array.isArray(body) ? body : [body];
    const results = await Promise.all(
      rows.map((row) => this.itemsService.createItem(projectId, table, row as Record<string, unknown>)),
    );
    return results;
  }

  async update(
    projectId: string,
    table: string,
    query: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<unknown[]> {
    // In Supabase, PATCH /rest/v1/:table?id=eq.X updates matching rows
    const filters = parseSupabaseFilter(query);
    const id = filters['id'];
    if (!id) throw new BadRequestException('Update requires ?id=eq.<id>');
    const result = await this.itemsService.updateItem(projectId, table, id, body);
    return [result];
  }

  async delete(
    projectId: string,
    table: string,
    query: Record<string, string>,
  ): Promise<unknown[]> {
    const filters = parseSupabaseFilter(query);
    const id = filters['id'];
    if (!id) throw new BadRequestException('Delete requires ?id=eq.<id>');
    const result = await this.itemsService.deleteItem(projectId, table, id);
    return [result];
  }
}
