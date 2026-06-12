import { PolicyCompilerService } from './policy-compiler.service';

function makePrisma(blueprint?: any, version?: any, entities?: any[], project?: any) {
  return {
    blueprint: { findFirst: jest.fn().mockResolvedValue(blueprint ?? null) },
    applicationVersion: { findUnique: jest.fn().mockResolvedValue(version ?? null) },
    appEntity: { findMany: jest.fn().mockResolvedValue(entities ?? []) },
    project: { findFirst: jest.fn().mockResolvedValue(project ?? null) },
  };
}

describe('PolicyCompilerService', () => {
  it('returns empty result when no blueprint found', async () => {
    const svc = new PolicyCompilerService(makePrisma() as any);
    const result = await svc.applyPolicies('p-1');
    expect(result.statementsExecuted).toBe(0);
    expect(result.errors[0]).toContain('blueprint');
  });

  it('returns empty result when no tables', async () => {
    const svc = new PolicyCompilerService(makePrisma(
      { currentVersionId: 'v-1' },
      { applicationModel: { roles: [{ name: 'admin', permissions: { customers: ['read'] } }] } },
      [], // no entities
    ) as any);
    const result = await svc.applyPolicies('p-1');
    expect(result.statementsExecuted).toBe(0);
  });
});
