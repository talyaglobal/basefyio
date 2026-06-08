import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as Docker from 'dockerode';
import { randomBytes } from 'crypto';

interface ProvisionPgOptions {
  projectId: string;
  projectSlug: string;
  memoryMb: number;
  cpuMillis: number;
}

interface ProvisionMinioOptions {
  teamId: string;
  teamSlug: string;
}

@Injectable()
export class InfrastructureService implements OnModuleInit {
  private readonly logger = new Logger(InfrastructureService.name);
  private docker!: Docker;
  private networkName!: string;
  private pgImage!: string;
  private minioImage!: string;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const socketPath = this.config.get<string>('docker.socketPath');
    this.networkName =
      this.config.get<string>('docker.network') || 'v0-kolaybase_default';
    this.pgImage =
      this.config.get<string>('docker.pgImage') || 'postgres:16-alpine';
    this.minioImage =
      this.config.get<string>('docker.minioImage') || 'minio/minio:latest';

    try {
      this.docker = new Docker({ socketPath });
      await this.docker.ping();
      this.enabled = true;
      this.logger.log('Docker client connected');

      await this.reconcile();
    } catch (err: any) {
      this.logger.warn(
        `Docker not available: ${err.message}. Dedicated infrastructure disabled.`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Provision Dedicated Postgres ─────────────────────

  async provisionPostgres(opts: ProvisionPgOptions): Promise<{
    host: string;
    port: number;
    adminUser: string;
    adminPassword: string;
    containerName: string;
  }> {
    if (!this.enabled) {
      throw new InternalServerErrorException(
        'Docker is not available for dedicated infrastructure',
      );
    }

    const containerName = `bf-pg-${opts.projectSlug}`;
    const volumeName = `bf-pg-${opts.projectSlug}-data`;
    const adminUser = 'postgres';
    const adminPassword = randomBytes(24).toString('base64url');

    this.logger.log(`Provisioning dedicated Postgres: ${containerName}`);

    try {
      await this.docker.createVolume({
        Name: volumeName,
        Labels: {
          'com.kolaybase.managed': 'true',
          'com.kolaybase.type': 'postgres-data',
          'com.kolaybase.owner': opts.projectId,
        },
      });
    } catch (err: any) {
      if (!err.message?.includes('already in use')) throw err;
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: this.pgImage,
      Env: [
        `POSTGRES_USER=${adminUser}`,
        `POSTGRES_PASSWORD=${adminPassword}`,
        `POSTGRES_DB=postgres`,
      ],
      Labels: {
        'com.kolaybase.managed': 'true',
        'com.kolaybase.type': 'postgres',
        'com.kolaybase.owner': opts.projectId,
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: opts.memoryMb * 1024 * 1024,
        NanoCpus: opts.cpuMillis * 1_000_000,
        Binds: [`${volumeName}:/var/lib/postgresql/data`],
        NetworkMode: this.networkName,
      },
      Healthcheck: {
        Test: ['CMD-SHELL', `pg_isready -U ${adminUser}`],
        Interval: 5_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 10,
      },
    });

    await container.start();

    await this.prisma.projectInfrastructure.upsert({
      where: { projectId: opts.projectId },
      update: {
        pgContainerName: containerName,
        pgContainerHost: containerName,
        pgContainerPort: 5432,
        pgAdminUser: adminUser,
        pgAdminPassword: adminPassword,
        pgMemoryMb: opts.memoryMb,
        pgCpuMillis: opts.cpuMillis,
        pgVolumeId: volumeName,
        status: 'PROVISIONING',
      },
      create: {
        projectId: opts.projectId,
        pgContainerName: containerName,
        pgContainerHost: containerName,
        pgContainerPort: 5432,
        pgAdminUser: adminUser,
        pgAdminPassword: adminPassword,
        pgMemoryMb: opts.memoryMb,
        pgCpuMillis: opts.cpuMillis,
        pgVolumeId: volumeName,
        status: 'PROVISIONING',
      },
    });

    await this.waitForHealthy(containerName, 60_000);

    await this.prisma.projectInfrastructure.update({
      where: { projectId: opts.projectId },
      data: { status: 'ACTIVE', provisionedAt: new Date() },
    });

    this.logger.log(`Dedicated Postgres provisioned: ${containerName}`);

    return {
      host: containerName,
      port: 5432,
      adminUser,
      adminPassword,
      containerName,
    };
  }

  // ── Provision Dedicated MinIO ────────────────────────

  async provisionMinio(opts: ProvisionMinioOptions): Promise<{
    host: string;
    port: number;
    accessKey: string;
    secretKey: string;
    containerName: string;
  }> {
    if (!this.enabled) {
      throw new InternalServerErrorException(
        'Docker is not available for dedicated infrastructure',
      );
    }

    const containerName = `bf-minio-${opts.teamSlug}`;
    const volumeName = `bf-minio-${opts.teamSlug}-data`;
    const accessKey = `bf-${opts.teamSlug}`;
    const secretKey = randomBytes(32).toString('base64url');

    this.logger.log(`Provisioning dedicated MinIO: ${containerName}`);

    try {
      await this.docker.createVolume({
        Name: volumeName,
        Labels: {
          'com.kolaybase.managed': 'true',
          'com.kolaybase.type': 'minio-data',
          'com.kolaybase.owner': opts.teamId,
        },
      });
    } catch (err: any) {
      if (!err.message?.includes('already in use')) throw err;
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: this.minioImage,
      Cmd: ['server', '/data', '--console-address', ':9001'],
      Env: [
        `MINIO_ROOT_USER=${accessKey}`,
        `MINIO_ROOT_PASSWORD=${secretKey}`,
      ],
      Labels: {
        'com.kolaybase.managed': 'true',
        'com.kolaybase.type': 'minio',
        'com.kolaybase.owner': opts.teamId,
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 512 * 1024 * 1024,
        Binds: [`${volumeName}:/data`],
        NetworkMode: this.networkName,
      },
    });

    await container.start();

    await this.prisma.teamInfrastructure.upsert({
      where: { teamId: opts.teamId },
      update: {
        minioContainerName: containerName,
        minioContainerHost: containerName,
        minioContainerPort: 9000,
        minioAccessKey: accessKey,
        minioSecretKey: secretKey,
        minioVolumeId: volumeName,
        status: 'ACTIVE',
        provisionedAt: new Date(),
      },
      create: {
        teamId: opts.teamId,
        minioContainerName: containerName,
        minioContainerHost: containerName,
        minioContainerPort: 9000,
        minioAccessKey: accessKey,
        minioSecretKey: secretKey,
        minioVolumeId: volumeName,
        status: 'ACTIVE',
        provisionedAt: new Date(),
      },
    });

    this.logger.log(`Dedicated MinIO provisioned: ${containerName}`);

    return {
      host: containerName,
      port: 9000,
      accessKey,
      secretKey,
      containerName,
    };
  }

  // ── Deprovision ──────────────────────────────────────

  async deprovisionPostgres(projectId: string): Promise<void> {
    const infra = await this.prisma.projectInfrastructure.findUnique({
      where: { projectId },
    });
    if (!infra?.pgContainerName) return;

    try {
      const container = this.docker.getContainer(infra.pgContainerName);
      try {
        await container.stop();
      } catch {
        /* already stopped */
      }
      await container.remove();
      this.logger.log(`Container ${infra.pgContainerName} removed`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to remove container ${infra.pgContainerName}: ${err.message}`,
      );
    }

    await this.prisma.projectInfrastructure.update({
      where: { projectId },
      data: { status: 'STOPPED' },
    });
  }

  async deprovisionMinio(teamId: string): Promise<void> {
    const infra = await this.prisma.teamInfrastructure.findUnique({
      where: { teamId },
    });
    if (!infra?.minioContainerName) return;

    try {
      const container = this.docker.getContainer(infra.minioContainerName);
      try {
        await container.stop();
      } catch {
        /* already stopped */
      }
      await container.remove();
      this.logger.log(`Container ${infra.minioContainerName} removed`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to remove container ${infra.minioContainerName}: ${err.message}`,
      );
    }

    await this.prisma.teamInfrastructure.update({
      where: { teamId },
      data: { status: 'STOPPED' },
    });
  }

  // ── Container Status ─────────────────────────────────

  async getContainerStatus(containerName: string): Promise<string> {
    if (!this.enabled) return 'unknown';
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      return info.State?.Status || 'unknown';
    } catch {
      return 'not_found';
    }
  }

  // ── Wait for healthy ─────────────────────────────────

  private async waitForHealthy(
    containerName: string,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const container = this.docker.getContainer(containerName);
        const info = await container.inspect();
        const health = info.State?.Health?.Status;
        if (health === 'healthy') return;
        if (info.State?.Status === 'exited') {
          throw new Error(`Container ${containerName} exited`);
        }
      } catch (err: any) {
        if (err.message?.includes('exited')) throw err;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    this.logger.warn(
      `Container ${containerName} did not become healthy within ${timeoutMs}ms`,
    );
  }

  // ── Reconciliation (startup) ─────────────────────────

  private async reconcile(): Promise<void> {
    this.logger.log('Reconciling dedicated infrastructure...');

    const pgInfras = await this.prisma.projectInfrastructure.findMany({
      where: { status: 'ACTIVE' },
    });

    for (const infra of pgInfras) {
      if (!infra.pgContainerName) continue;
      const status = await this.getContainerStatus(infra.pgContainerName);

      if (status === 'exited' || status === 'not_found') {
        this.logger.warn(
          `Restarting stopped container: ${infra.pgContainerName}`,
        );
        try {
          if (status === 'exited') {
            const container = this.docker.getContainer(infra.pgContainerName);
            await container.start();
          }
          if (status === 'not_found') {
            await this.prisma.projectInfrastructure.update({
              where: { id: infra.id },
              data: { status: 'FAILED' },
            });
          }
        } catch (err: any) {
          this.logger.error(
            `Failed to restart ${infra.pgContainerName}: ${err.message}`,
          );
          await this.prisma.projectInfrastructure.update({
            where: { id: infra.id },
            data: { status: 'FAILED' },
          });
        }
      }
    }

    const minioInfras = await this.prisma.teamInfrastructure.findMany({
      where: { status: 'ACTIVE' },
    });

    for (const infra of minioInfras) {
      if (!infra.minioContainerName) continue;
      const status = await this.getContainerStatus(infra.minioContainerName);

      if (status === 'exited') {
        try {
          const container = this.docker.getContainer(
            infra.minioContainerName,
          );
          await container.start();
        } catch (err: any) {
          this.logger.error(
            `Failed to restart ${infra.minioContainerName}: ${err.message}`,
          );
          await this.prisma.teamInfrastructure.update({
            where: { id: infra.id },
            data: { status: 'FAILED' },
          });
        }
      } else if (status === 'not_found') {
        await this.prisma.teamInfrastructure.update({
          where: { id: infra.id },
          data: { status: 'FAILED' },
        });
      }
    }

    this.logger.log('Infrastructure reconciliation complete');
  }
}
