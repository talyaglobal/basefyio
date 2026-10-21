import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Dashboard routes under /projects/:projectId: the caller must belong to the
 * project's team. Missing project → 404, non-member → 403.
 */
export async function assertProjectTeamMember(
  prisma: PrismaService,
  projectId: string,
  userId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, status: { not: 'DELETED' } },
    select: { teamId: true },
  });
  if (!project) throw new NotFoundException('Project not found');

  const member = await prisma.teamMember.findFirst({
    where: { teamId: project.teamId, userId },
  });
  if (!member) throw new ForbiddenException('Not a team member');
}
