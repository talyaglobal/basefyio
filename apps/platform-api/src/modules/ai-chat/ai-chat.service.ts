import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** How much history is kept per person, so the table cannot grow without end. */
const MAX_SESSIONS_PER_USER_TEAM = 30;
const MAX_MESSAGES_PER_SESSION = 200;

export interface ChatMessageInput {
  role: string;
  content: string;
}

/**
 * The dashboard assistant's conversation history.
 *
 * One rule governs this whole file: a session is only ever reached through its
 * owner. Every query carries the caller's user id in its WHERE clause, and
 * nothing is fetched by id alone — not even for a check, because a lookup that
 * succeeds and is then compared leaks whether the id exists.
 *
 * A session that is not yours is reported as missing rather than forbidden,
 * for the same reason: "forbidden" confirms it is someone's.
 */
@Injectable()
export class AiChatService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own sessions, newest first, without message bodies. */
  async listSessions(userId: string, teamId: string) {
    const sessions = await this.prisma.aiChatSession.findMany({
      where: { userId, teamId },
      orderBy: { updatedAt: 'desc' },
      take: MAX_SESSIONS_PER_USER_TEAM,
      select: {
        id: true,
        title: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
    return sessions.map(({ _count, ...s }) => ({ ...s, messageCount: _count.messages }));
  }

  /** One session with its turns. Throws NotFound when it is not the caller's. */
  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.aiChatSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, content: true, createdAt: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Chat session not found');
    return session;
  }

  async createSession(userId: string, teamId: string, projectId?: string, title?: string) {
    const session = await this.prisma.aiChatSession.create({
      data: { userId, teamId, projectId: projectId || null, title: title?.slice(0, 200) || null },
      select: { id: true, title: true, projectId: true, createdAt: true, updatedAt: true },
    });
    await this.pruneSessions(userId, teamId);
    return session;
  }

  /**
   * Append turns to a session the caller owns.
   *
   * The ownership check and the write are one transaction: without it, a
   * session deleted between the two would leave messages pointing at nothing.
   */
  async appendMessages(userId: string, sessionId: string, messages: ChatMessageInput[]) {
    const clean = messages
      .filter((m) => m && typeof m.content === 'string' && m.content.length > 0)
      .map((m) => ({
        sessionId,
        role: String(m.role || 'user').slice(0, 16),
        content: m.content,
      }));
    if (!clean.length) return { appended: 0 };

    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.aiChatSession.findFirst({
        where: { id: sessionId, userId },
        select: { id: true, title: true },
      });
      if (!owned) throw new NotFoundException('Chat session not found');

      await tx.aiChatMessage.createMany({ data: clean });

      // The first thing the person said names the conversation, which is what
      // the sidebar shows; set it once and leave it alone afterwards.
      const firstUserTurn = clean.find((m) => m.role === 'user');
      await tx.aiChatSession.update({
        where: { id: sessionId },
        data: {
          updatedAt: new Date(),
          ...(owned.title || !firstUserTurn
            ? {}
            : { title: firstUserTurn.content.slice(0, 200) }),
        },
      });

      await this.pruneMessages(tx, sessionId);
      return { appended: clean.length };
    });
  }

  async deleteSession(userId: string, sessionId: string) {
    const { count } = await this.prisma.aiChatSession.deleteMany({
      where: { id: sessionId, userId },
    });
    if (!count) throw new NotFoundException('Chat session not found');
    return { deleted: true };
  }

  async clearAll(userId: string, teamId: string) {
    const { count } = await this.prisma.aiChatSession.deleteMany({ where: { userId, teamId } });
    return { deleted: count };
  }

  /** Drop the oldest sessions once someone is past the cap. */
  private async pruneSessions(userId: string, teamId: string) {
    const stale = await this.prisma.aiChatSession.findMany({
      where: { userId, teamId },
      orderBy: { updatedAt: 'desc' },
      skip: MAX_SESSIONS_PER_USER_TEAM,
      select: { id: true },
    });
    if (stale.length) {
      await this.prisma.aiChatSession.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }

  /** Keep the tail of a long conversation; the opening turns age out first. */
  private async pruneMessages(tx: any, sessionId: string) {
    const total = await tx.aiChatMessage.count({ where: { sessionId } });
    if (total <= MAX_MESSAGES_PER_SESSION) return;
    const excess = await tx.aiChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: total - MAX_MESSAGES_PER_SESSION,
      select: { id: true },
    });
    await tx.aiChatMessage.deleteMany({ where: { id: { in: excess.map((m: any) => m.id) } } });
  }
}
