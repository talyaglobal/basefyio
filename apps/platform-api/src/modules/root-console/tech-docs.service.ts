import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The root console's technical documentation: pages describing the platform
 * itself (hosts, modules, routes, data stores, deploy flow, runbooks). They
 * are written by the operator's sync script straight into tech_docs and only
 * read here, so nothing that names a host or a volume passes through the
 * public repository.
 */
export interface TechDocSummary {
  slug: string;
  title: string;
  section: string;
  sortOrder: number;
  summary: string;
  bytes: number;
  sourceCommit: string | null;
  updatedAt: string;
}

export interface TechDocPage extends TechDocSummary {
  body: string;
}

@Injectable()
export class TechDocsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TechDocSummary[]> {
    const rows = await this.prisma.techDoc.findMany({
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      select: { slug: true, title: true, section: true, sortOrder: true, summary: true, sourceCommit: true, updatedAt: true, body: true },
    });
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      section: r.section,
      sortOrder: r.sortOrder,
      summary: r.summary,
      bytes: Buffer.byteLength(r.body, 'utf8'),
      sourceCommit: r.sourceCommit,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async get(slug: string): Promise<TechDocPage> {
    const row = await this.prisma.techDoc.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException('No such page');
    return {
      slug: row.slug,
      title: row.title,
      section: row.section,
      sortOrder: row.sortOrder,
      summary: row.summary,
      bytes: Buffer.byteLength(row.body, 'utf8'),
      sourceCommit: row.sourceCommit,
      updatedAt: row.updatedAt.toISOString(),
      body: row.body,
    };
  }
}
