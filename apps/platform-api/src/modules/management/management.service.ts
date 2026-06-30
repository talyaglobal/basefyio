import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Root-only internal plan documents (Gamification, Go-To-Market) stored as markdown. */
@Injectable()
export class ManagementService {
  constructor(private readonly prisma: PrismaService) {}

  async getDoc(slug: string) {
    const doc = await this.prisma.managementDoc.findUnique({ where: { slug } });
    return doc ?? { slug, title: '', content: '', updatedAt: null };
  }

  async updateDoc(slug: string, data: { title?: string; content: string }) {
    return this.prisma.managementDoc.upsert({
      where: { slug },
      update: { content: data.content, ...(data.title !== undefined ? { title: data.title } : {}) },
      create: { slug, title: data.title || slug, content: data.content },
    });
  }
}
