import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import AdmZip = require('adm-zip');
import { ProjectsService } from './projects.service';
import { ProjectActivityKind, ProjectActivityService } from './project-activity.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { StorageService } from '../storage/storage.service';

const execFileAsync = promisify(execFile);

type ZipImportMode = 'existing' | 'new';

// An export always carries at least one of these; a ZIP with none would
// otherwise create an empty project (or leave the target untouched) and report success.
const EXPORT_MARKERS = ['manifest.json', 'project.json', 'database/dump.sql'];
const NOT_AN_EXPORT =
  'This ZIP is not a basefyio project export: it has no manifest.json, project.json or database/dump.sql.';

@Injectable()
export class ProjectArchiveImportService {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly storage: StorageService,
    private readonly activity: ProjectActivityService,
  ) {}

  async importArchive(
    file: Express.Multer.File,
    userId: string,
    body: {
      teamId?: string;
      nameMode?: ZipImportMode;
      newProjectName?: string;
      existingProjectId?: string;
      confirmProjectName?: string;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('ZIP file is required');
    }
    // Overriding writes into a live project: the caller must type its exact name.
    const existingId = body.existingProjectId?.trim();
    if (existingId) {
      const target = await this.projectsService.getProjectForSupabaseImport(existingId, userId);
      if (body.confirmProjectName?.trim() !== target.name) {
        throw new BadRequestException(
          'Type the exact project name to confirm overriding it with this ZIP.',
        );
      }
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

    const tmpRoot = await mkdtemp(join(tmpdir(), 'basefyio-zip-import-'));
    const extractDir = join(tmpRoot, 'extracted');
    await mkdir(extractDir, { recursive: true });

    try {
      let zip: AdmZip;
      try {
        zip = new AdmZip(zipBuffer);
      } catch {
        throw new BadRequestException('The uploaded file is not a valid ZIP archive.');
      }
      zip.extractAllTo(extractDir, true);

      if (!EXPORT_MARKERS.some((m) => existsSync(join(extractDir, m)))) {
        throw new BadRequestException(NOT_AN_EXPORT);
      }

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
            'ZIP',
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

      await this.activity.append(project.id, {
        userId,
        kind: ProjectActivityKind.PROJECT_ZIP_IMPORTED,
        title: 'Project ZIP imported',
        detail: warnings.length ? `${warnings.length} warning(s)` : null,
      });

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
      const tempPassword = `Bf-${randomBytes(8).toString('hex')}`;
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

      // The name comes from the uploaded archive, and createBucket above is
      // wrapped in a bare catch, so its validation cannot be relied on here.
      // join() normalises "..", which let a crafted archive walk out of the
      // extraction directory and read the container filesystem — every
      // tenant's database password among it, echoed back through the
      // per-object warnings. Resolve, then require the result to stay inside.
      const bucketDir = resolve(storageRoot, bucketName);
      const root = resolve(storageRoot);
      if (bucketDir !== root && !bucketDir.startsWith(root + sep)) {
        warnings.push(`Storage bucket skipped: "${bucketName}" resolves outside the archive`);
        continue;
      }
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

