import { describe, expect, it } from 'vitest';
import {
  afterRotationLines,
  buildRotationReport,
  connectMatchesRotation,
  rotationWarningLines,
  type ProjectConnectInfo,
} from './db-password';

const connect = (over: Partial<ProjectConnectInfo> = {}): ProjectConnectInfo => ({
  uri: 'postgresql://app_user:new-pass@db.example.com:5432/app_db',
  poolerUri: 'postgresql://app_user:new-pass@db.example.com:6432/app_db',
  host: 'db.example.com',
  port: 5432,
  database: 'app_db',
  user: 'app_user',
  password: 'new-pass',
  poolerHost: 'db.example.com',
  poolerPort: 6432,
  ...over,
});

describe('buildRotationReport', () => {
  it('takes the owner connection strings from the API', () => {
    const report = buildRotationReport({ projectId: 'p1', target: 'owner', password: 'new-pass', connect: connect() });
    expect(report).toEqual({
      projectId: 'p1',
      target: 'owner',
      user: 'app_user',
      password: 'new-pass',
      connectionString: 'postgresql://app_user:new-pass@db.example.com:6432/app_db',
      directConnectionString: 'postgresql://app_user:new-pass@db.example.com:5432/app_db',
    });
  });

  it('never pairs owner URIs with a read-only password', () => {
    const report = buildRotationReport({
      projectId: 'p1',
      target: 'readonly',
      password: 'ro-pass',
      user: 'app_user_readonly',
      connect: connect(),
    });
    expect(report.user).toBe('app_user_readonly');
    expect(report.connectionString).toBeUndefined();
    expect(report.directConnectionString).toBeUndefined();
  });

  it('still reports the password when the connect route was unavailable', () => {
    const report = buildRotationReport({ projectId: 'p1', target: 'owner', password: 'new-pass', connect: null });
    expect(report.password).toBe('new-pass');
    expect(report.connectionString).toBeUndefined();
  });
});

describe('connectMatchesRotation', () => {
  it('accepts connect details carrying the new password only', () => {
    expect(connectMatchesRotation(connect(), 'new-pass')).toBe(true);
    expect(connectMatchesRotation(connect({ password: 'old-pass' }), 'new-pass')).toBe(false);
    expect(connectMatchesRotation(null, 'new-pass')).toBe(false);
  });
});

describe('rotation messages', () => {
  it('says the old password stops working', () => {
    expect(rotationWarningLines('owner', 'Shop').join(' ')).toMatch(/stops working immediately/);
    expect(rotationWarningLines('readonly', 'Shop').join(' ')).toMatch(/read-only/);
  });

  it('tells the user what still has to be updated', () => {
    expect(afterRotationLines('owner', false).join(' ')).toMatch(/--write-env/);
    expect(afterRotationLines('owner', true)[0]).toMatch(/^Updated \.env/);
    expect(afterRotationLines('readonly', false).join(' ')).toMatch(/read-only user/);
  });
});
