import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as Minio from 'minio';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const BUCKET = 'bf-item-files';

export interface ItemFileMetadata {
  id: string;
  itemId: string;
  entityName: string;
  projectId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  uploadedAt: string;
}

@Injectable()
export class ItemFilesService {
  private readonly minio: Minio.Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.minio = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey: this.config.get<string>('minio.accessKey') || 'basefyio',
      secretKey: this.config.get<string>('minio.secretKey') || 'basefyio_secret',
    });
  }

  private async ensureBucket(): Promise<void> {
    try {
      const exists = await this.minio.bucketExists(BUCKET);
      if (!exists) {
        await this.minio.makeBucket(BUCKET, 'us-east-1');
      }
    } catch {
      // Non-fatal in unit tests
    }
  }

  private async getProjectPool(projectId: string): Promise<Pool> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    return new Pool({
      host: project.dbHost,
      port: project.dbPort,
      database: project.dbName,
      user: project.dbUser,
      password: project.dbPassword,
      statement_timeout: 10_000,
      max: 2,
    });
  }

  private async ensureFilesTable(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "_item_files" (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id     TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        filename    TEXT NOT NULL,
        mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
        size        BIGINT NOT NULL DEFAULT 0,
        storage_key TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "_item_files_item_id_idx" ON "_item_files"(item_id);
    `);
  }

  async uploadFile(
    projectId: string,
    entityName: string,
    itemId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<ItemFileMetadata> {
    await this.ensureBucket();

    const fileId = randomUUID();
    const storageKey = `${projectId}/${entityName}/${itemId}/${fileId}/${file.originalname}`;

    // Upload to MinIO
    await this.minio.putObject(BUCKET, storageKey, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    });

    // Store metadata in project DB
    const pool = await this.getProjectPool(projectId);
    try {
      await this.ensureFilesTable(pool);
      const result = await pool.query(
        `INSERT INTO "_item_files" (id, item_id, entity_name, filename, mime_type, size, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [fileId, itemId, entityName, file.originalname, file.mimetype, file.size, storageKey],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        itemId: row.item_id,
        entityName: row.entity_name,
        projectId,
        filename: row.filename,
        mimeType: row.mime_type,
        size: Number(row.size),
        storageKey: row.storage_key,
        uploadedAt: row.uploaded_at,
      };
    } finally {
      await pool.end();
    }
  }

  async listFiles(
    projectId: string,
    entityName: string,
    itemId: string,
  ): Promise<ItemFileMetadata[]> {
    const pool = await this.getProjectPool(projectId);
    try {
      await this.ensureFilesTable(pool);
      const result = await pool.query(
        `SELECT * FROM "_item_files" WHERE item_id = $1 AND entity_name = $2 ORDER BY uploaded_at DESC`,
        [itemId, entityName],
      );
      return result.rows.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        entityName: row.entity_name,
        projectId,
        filename: row.filename,
        mimeType: row.mime_type,
        size: Number(row.size),
        storageKey: row.storage_key,
        uploadedAt: row.uploaded_at,
      }));
    } finally {
      await pool.end();
    }
  }

  async getFileStream(
    projectId: string,
    fileId: string,
  ): Promise<{ stream: NodeJS.ReadableStream; metadata: ItemFileMetadata }> {
    const pool = await this.getProjectPool(projectId);
    let metadata: ItemFileMetadata;
    try {
      await this.ensureFilesTable(pool);
      const result = await pool.query(`SELECT * FROM "_item_files" WHERE id = $1`, [fileId]);
      if (result.rows.length === 0) throw new NotFoundException(`File '${fileId}' not found`);
      const row = result.rows[0];
      metadata = {
        id: row.id,
        itemId: row.item_id,
        entityName: row.entity_name,
        projectId,
        filename: row.filename,
        mimeType: row.mime_type,
        size: Number(row.size),
        storageKey: row.storage_key,
        uploadedAt: row.uploaded_at,
      };
    } finally {
      await pool.end();
    }

    const stream = await this.minio.getObject(BUCKET, metadata.storageKey);
    return { stream, metadata };
  }

  async deleteFile(projectId: string, fileId: string): Promise<{ deleted: boolean; id: string }> {
    const pool = await this.getProjectPool(projectId);
    try {
      await this.ensureFilesTable(pool);
      const result = await pool.query(
        `DELETE FROM "_item_files" WHERE id = $1 RETURNING storage_key`,
        [fileId],
      );
      if (result.rows.length === 0) throw new NotFoundException(`File '${fileId}' not found`);
      const storageKey = result.rows[0].storage_key;
      await this.minio.removeObject(BUCKET, storageKey).catch(() => undefined);
      return { deleted: true, id: fileId };
    } finally {
      await pool.end();
    }
  }
}
