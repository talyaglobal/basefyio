import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';

// ── View interfaces ────────────────────────────────────────────────────────────
// Sensitive fields (dbPassword, anonKey, serviceKey, credentialRef) are
// intentionally never selected from the DB and never included in any view.

export interface EndpointSnippets {
  psql?: string;        // relational only
  dbeaver?: string;     // relational only
  compass?: string;     // mongodb only
  sdkExample?: string;  // all types
}

export interface EndpointView {
  engineType: string;         // 'relational' | 'mongodb' | 'couchbase'
  host: string;
  port: number;
  username: string;           // safe to expose
  database: string;           // project.dbName
  requiresClientCert: boolean;
  accessLevel: string;        // 'READ' | 'READ_WRITE'
  active: boolean;
  connectionString: string;   // NEVER includes password or private key
  sslMode: string;            // 'verify-full' for relational, 'tls' for others
  snippets: EndpointSnippets;
}

export interface AccessInfoView {
  projectId: string;
  slug: string;
  endpoints: EndpointView[];
  entitlements: Record<string, boolean>;
  warning?: string;
}

// ── Helper: build EndpointView from an endpoint row + project.dbName ──────────

function buildEndpointView(
  endpoint: {
    engineType: string;
    host: string;
    port: number;
    username: string;
    requiresClientCert: boolean;
    accessLevel: string;
    active: boolean;
  },
  dbName: string,
): EndpointView {
  const { engineType, host, port, username, requiresClientCert, accessLevel, active } = endpoint;

  let connectionString: string;
  let sslMode: string;
  const snippets: EndpointSnippets = {};

  if (engineType === 'relational') {
    sslMode = 'verify-full';
    connectionString = `postgresql://${username}@${host}:${port}/${dbName}?sslmode=verify-full`;
    snippets.psql = `psql "sslmode=verify-full sslcert=client.pem sslkey=client.key sslrootcert=ca.pem host=${host} port=${port} dbname=${dbName} user=${username}"`;
    snippets.dbeaver = `DBeaver → New Connection → PostgreSQL → host: ${host} port: ${port} database: ${dbName} user: ${username} → SSL tab: enable client cert`;
    snippets.sdkExample = `const client = new Client({ host: '${host}', port: ${port}, database: '${dbName}', user: '${username}', ssl: { cert, key, ca } });`;
  } else if (engineType === 'mongodb') {
    sslMode = 'tls';
    connectionString = `mongodb://${username}@${host}:${port}/${dbName}?tls=true`;
    snippets.compass = `mongodb://${username}@${host}:${port}/${dbName}?tls=true&tlsCertificateKeyFile=client.pem&tlsCAFile=ca.pem`;
    snippets.sdkExample = `const client = new MongoClient('mongodb://${username}@${host}:${port}/${dbName}?tls=true', { tlsCertificateKeyFile: 'client.pem' });`;
  } else {
    // couchbase
    sslMode = 'tls';
    connectionString = `couchbases://${host}`;
    snippets.sdkExample = `const client = new MongoClient('mongodb://${username}@${host}:${port}/${dbName}?tls=true', { tlsCertificateKeyFile: 'client.pem' });`;
  }

  return {
    engineType,
    host,
    port,
    username,
    database: dbName,
    requiresClientCert,
    accessLevel,
    active,
    connectionString,
    sslMode,
    snippets,
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class DeveloperAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementService: EntitlementService,
  ) {}

  // ---------------------------------------------------------------------------
  // assertProjectMember — same pattern as other services
  // ---------------------------------------------------------------------------

  async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException("Not a member of this project's team");
  }

  // ---------------------------------------------------------------------------
  // getAccessInfo
  // ---------------------------------------------------------------------------

  async getAccessInfo(projectId: string, userId: string): Promise<AccessInfoView> {
    await this.assertProjectMember(projectId, userId);

    // Load project — intentionally excludes dbPassword, anonKey, serviceKey
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, dbName: true, teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    // Load active endpoints — intentionally excludes credentialRef
    const endpointRows = await this.prisma.projectEngineEndpoint.findMany({
      where: { projectId, active: true },
      select: {
        engineType: true,
        host: true,
        port: true,
        username: true,
        requiresClientCert: true,
        accessLevel: true,
        active: true,
      },
    });

    // Resolve entitlements
    const resolved = await this.entitlementService.resolve(projectId);
    const entitlements = resolved as Record<string, boolean>;

    // Gate on externalDbAccess entitlement
    if (entitlements['externalDbAccess'] !== true) {
      return {
        projectId,
        slug: project.slug,
        endpoints: [],
        entitlements,
        warning:
          'External database access is not enabled on your current plan. Upgrade to unlock direct connection.',
      };
    }

    // Build endpoint views
    const endpoints: EndpointView[] = endpointRows.map((row) =>
      buildEndpointView(row, project.dbName),
    );

    const view: AccessInfoView = {
      projectId,
      slug: project.slug,
      endpoints,
      entitlements,
    };

    if (endpoints.length === 0) {
      view.warning =
        'No engine endpoints are provisioned for this project yet. Endpoints are created automatically when a data structure is added.';
    }

    return view;
  }
}
