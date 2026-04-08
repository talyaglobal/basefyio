import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import AdmZip from 'adm-zip';
import { ProjectsService } from './projects.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { StorageService } from '../storage/storage.service';

const execFileAsync = promisify(execFile);

type ZipImportMode = 'existing' | 'new';

@Injectable()
export class ProjectArchiveImportService {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly storage: StorageService,
  ) {}

  async importArchive(
    file: Express.Multer.File,
    userId: string,
    body: {
      teamId?: string;
      nameMode?: ZipImportMode;
      newProjectName?: string;
      existingProjectId?: string;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('ZIP file is required');
    }
    return this.importArchiveBuffer(file.buffer, userId, body);
  }

  async importArchiveBuffer(
    zipBuffer: Buffer,
    userId: string,
    body: {
      teamId?: string;
      nameMode?: ZipImportMode;
      newProjectName?: string;
      existingProjectId?: string;
    },
  ) {
    if (!zipBuffer?.length) {
      throw new BadRequestException('ZIP file is required');
    }
      if (!body.teamId?.trim() && !body.existingProjectId?.trim()) {
      throw new BadRequestException('teamId is required');
    }

    const tmpRoot = await mkdtemp(join(tmpdir(), 'kb-zip-import-'));
    const extractDir = join(tmpRoot, 'extracted');
    await mkdir(extractDir, { recursive: true });

    try {
      const zip = new AdmZip(zipBuffer);
      zip.extractAllTo(extractDir, true);

      const metadataPath = join(extractDir, 'project.json');
      let exportedName = 'Imported Project';
      if (existsSync(metadataPath)) {
        const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as {
          name?: string;
        };
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          exportedName = parsed.name.trim();
        }
      }

      const useExistingProject = !!body.existingProjectId?.trim();
      const finalName =
        body.nameMode === 'new'
          ? body.newProjectName?.trim()
          : exportedName;
      if (!useExistingProject && !finalName) {
        throw new BadRequestException('newProjectName is required when nameMode is "new"');
      }

      const project = useExistingProject
        ? await this.projectsService.getProjectForSupabaseImport(
            body.existingProjectId!.trim(),
            userId,
          )
        : await this.projectsService.create(
            { name: finalName!, teamId: body.teamId!.trim() },
            userId,
          );

      const warnings: string[] = [];

      const dumpPath = join(extractDir, 'database', 'dump.sql');
      if (existsSync(dumpPath)) {
        await this.restoreDatabaseDump(project, dumpPath);
      } else {
        warnings.push('database/dump.sql not found in archive, database restore skipped.');
      }

      const authUsersPath = join(extractDir, 'auth', 'users.json');
      if (existsSync(authUsersPath)) {
        await this.restoreAuthUsers(project.keycloakRealm, authUsersPath, warnings);
      }

      const storageRoot = join(extractDir, 'storage');
      const bucketsPath = join(storageRoot, 'buckets.json');
      if (existsSync(storageRoot) && existsSync(bucketsPath)) {
        await this.restoreStorage(project.id, storageRoot, bucketsPath, warnings);
      }

      return {
        project: { id: project.id, name: project.name, slug: project.slug },
        importedName: exportedName,
        appliedName: useExistingProject ? project.name : finalName!,
        warnings,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(error?.message || 'ZIP import failed');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  private async restoreDatabaseDump(
    project: {
      dbHost: string;
      dbPort: number;
      dbUser: string;
      dbPassword: string;
      dbName: string;
    },
    dumpPath: string,
  ) {
    await execFileAsync(
      'psql',
      [
        '--host',
        project.dbHost,
        '--port',
        String(project.dbPort),
        '--username',
        project.dbUser,
        '--dbname',
        project.dbName,
        '--file',
        dumpPath,
      ],
      {
        env: {
          ...process.env,
          PGPASSWORD: project.dbPassword,
          PGCONNECT_TIMEOUT: '10',
        },
      },
    );
  }

  private async restoreAuthUsers(
    realmName: string,
    authUsersPath: string,
    warnings: string[],
  ) {
    const raw = await readFile(authUsersPath, 'utf8');
    const users = JSON.parse(raw) as Array<{
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      enabled?: boolean;
    }>;
    if (!Array.isArray(users)) return;

    for (const u of users) {
      if (!u.email?.trim()) continue;
      const tempPassword = `Kb-${randomBytes(8).toString('hex')}`;
      try {
        await this.keycloak.createUser(realmName, {
          email: u.email.trim(),
          username: u.username?.trim(),
          firstName: u.firstName?.trim(),
          lastName: u.lastName?.trim(),
          password: tempPassword,
        });
      } catch {
        warnings.push(`Auth user skipped: ${u.email}`);
      }
    }
  }

  private async restoreStorage(
    projectId: string,
    storageRoot: string,
    bucketsPath: string,
    warnings: string[],
  ) {
    const raw = await readFile(bucketsPath, 'utf8');
    const buckets = JSON.parse(raw) as Array<{ name?: string; public?: boolean }>;
    if (!Array.isArray(buckets)) return;

    for (const bucket of buckets) {
      const bucketName = bucket.name?.trim();
      if (!bucketName) continue;
      try {
        await this.storage.createBucket(projectId, undefined, bucketName, !!bucket.public);
      } catch {
        // Bucket may already exist.
      }

      const bucketDir = join(storageRoot, bucketName);
      if (!existsSync(bucketDir)) continue;
      const files = await this.listFiles(bucketDir);
      for (const filePath of files) {
        const objectPath = relative(bucketDir, filePath).replace(/\\/g, '/');
        try {
          const fileBuffer = await readFile(filePath);
          await this.storage.uploadObject(
            projectId,
            undefined,
            bucketName,
            objectPath,
            fileBuffer,
            'application/octet-stream',
          );
        } catch {
          warnings.push(`Storage object skipped: ${bucketName}/${objectPath}`);
        }
      }
    }
  }

  private async listFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      const st = await stat(fullPath);
      if (st.isDirectory()) {
        files.push(...(await this.listFiles(fullPath)));
      } else if (st.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }
}

