import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import {
  decryptField,
  encryptField,
  isEncryptionEnabled,
} from '../../common/crypto/field-crypto';

/** bcrypt as Supabase writes it ($2a$), and its $2b$ / $2y$ siblings. */
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export interface PasswordHashEntry {
  userId: string;
  email: string;
  hash: string;
}

/**
 * Passwords that came with an imported project.
 *
 * The source stores bcrypt hashes, and Keycloak verifies only its own formats,
 * so a hash cannot simply be handed over. Rather than make every migrated user
 * reset their password, the hash waits beside the project and is checked the
 * first time its owner signs in: a correct password is then set in Keycloak,
 * the hash is dropped, and every later sign-in is Keycloak's alone.
 */
@Injectable()
export class ImportedPasswordService {
  private readonly logger = new Logger(ImportedPasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  static isSupportedHash(hash: unknown): hash is string {
    return typeof hash === 'string' && BCRYPT.test(hash);
  }

  /**
   * Keep the hashes of imported users until they sign in, and return how many
   * are waiting. A hash that has settled is never armed again: a later sync
   * must not bring back a password its owner has since replaced. A pending one
   * takes the source's newest hash, for a password changed there meanwhile.
   */
  async stash(projectId: string, entries: PasswordHashEntry[], source = 'supabase'): Promise<number> {
    const usable = entries.filter(
      (e) => e.userId && e.email?.trim() && ImportedPasswordService.isSupportedHash(e.hash),
    );
    let pending = 0;
    for (let i = 0; i < usable.length; i += 500) {
      const batch = usable.slice(i, i + 500);
      const existing = await this.prisma.importedPasswordHash.findMany({
        where: { projectId, keycloakUserId: { in: batch.map((e) => e.userId) } },
        select: { id: true, keycloakUserId: true, passwordHash: true, settledAt: true },
      });
      const known = new Map(existing.map((r) => [r.keycloakUserId, r]));

      const fresh = batch.filter((e) => !known.has(e.userId));
      if (fresh.length) {
        await this.prisma.importedPasswordHash.createMany({
          data: fresh.map((e) => ({
            projectId,
            keycloakUserId: e.userId,
            email: e.email.trim().toLowerCase(),
            passwordHash: this.protect(e.hash),
            source,
          })),
          skipDuplicates: true,
        });
      }
      pending += fresh.length;

      for (const e of batch) {
        const row = known.get(e.userId);
        if (!row || row.settledAt) continue;
        pending++;
        if (decryptField(row.passwordHash) === e.hash) continue;
        await this.prisma.importedPasswordHash.update({
          where: { id: row.id },
          data: { passwordHash: this.protect(e.hash), email: e.email.trim().toLowerCase() },
        });
      }
    }
    return pending;
  }

  /**
   * Called after Keycloak refused a password. When the account is an imported
   * one still waiting for its first sign-in, check the password against the
   * hash it came with and, on a match, give it to Keycloak. True means the
   * caller should try the sign-in again.
   *
   * Never throws for an ordinary miss: a wrong password, an unknown address or
   * an unreachable Keycloak all leave the original refusal to stand.
   */
  async adoptOnSignIn(
    projectId: string,
    realm: string,
    email: string,
    password: string,
  ): Promise<boolean> {
    const norm = (email || '').trim().toLowerCase();
    if (!norm || !password) return false;

    // This runs on every refused sign-in, so a failure here must leave the
    // refusal a 401 rather than turn it into a 500.
    const row = await this.prisma.importedPasswordHash
      .findFirst({ where: { projectId, email: norm, settledAt: null } })
      .catch((err: any) => {
        this.logger.warn(`Imported password lookup failed: ${err?.message ?? err}`);
        return null;
      });
    if (!row?.passwordHash) return false;

    let userId: string;
    try {
      const user = await this.keycloak.getRealmUserById(realm, row.keycloakUserId);
      // Gone, or its address has changed since the import: the hash no longer
      // belongs to whoever signs in with this one.
      if (!user || (user.email || '').trim().toLowerCase() !== norm) {
        await this.settle(row.id);
        return false;
      }
      if (!user.enabled) return false;
      userId = row.keycloakUserId;

      // Keycloak has already counted this attempt. An account it locked must
      // not be opened by a second, unthrottled check here.
      if (await this.keycloak.isUserLockedOut(realm, userId)) return false;

      // A password set in Keycloak since the import replaces the old one.
      if (await this.keycloak.userHasPasswordCredential(realm, userId)) {
        await this.settle(row.id);
        return false;
      }
    } catch (err: any) {
      this.logger.warn(`Imported password check skipped for realm "${realm}": ${err?.message ?? err}`);
      return false;
    }

    const hash = decryptField(row.passwordHash) as string;
    if (!(await bcrypt.compare(password, hash))) return false;

    try {
      await this.keycloak.resetRealmUserPassword(realm, userId, password);
    } catch (err: any) {
      // The realm's password rules refuse it (the source allowed shorter
      // passwords). The person proved who they are, but this password cannot
      // come along; the hash stays, in case the rules are relaxed.
      if (err?.response?.status === 400) {
        throw new UnauthorizedException({
          message:
            "The password is correct, but it does not meet this project's password rules. Reset your password to continue.",
          code: 'password_reset_required',
        });
      }
      this.logger.warn(`Imported password not set for ${userId} in realm "${realm}": ${err?.message ?? err}`);
      return false;
    }

    await this.settle(row.id);
    this.logger.log(`Imported password adopted for user ${userId} in realm "${realm}"`);
    return true;
  }

  /**
   * A successful sign-in means Keycloak holds a password for the user, so any
   * hash still waiting for them is spent. Cheap when there is none.
   */
  async settleForUser(projectId: string, userId: string): Promise<void> {
    await this.prisma.importedPasswordHash.updateMany({
      where: { projectId, keycloakUserId: userId, settledAt: null },
      data: { settledAt: new Date(), passwordHash: null },
    });
  }

  private async settle(id: string): Promise<void> {
    await this.prisma.importedPasswordHash.update({
      where: { id },
      data: { settledAt: new Date(), passwordHash: null },
    });
  }

  /**
   * Encrypted when the installation has a key. Without one the hash is kept as
   * the source kept it: bcrypt is one-way, and refusing would cost every
   * migrated user their password.
   */
  private protect(hash: string): string {
    return isEncryptionEnabled() ? (encryptField(hash) as string) : hash;
  }
}
