import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';

/**
 * The two callers that exist — the dashboard wizard and the CLI — must keep
 * validating, and a body with no team must not.
 */
const TEAM = '2c2d9e3e-2b4b-4a5d-9c8e-1f2a3b4c5d6e';

async function errorsFor(body: unknown) {
  return validate(plainToInstance(CreateProjectDto, body), { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateProjectDto', () => {
  it('accepts what the dashboard wizard sends', async () => {
    const errors = await errorsFor({ name: 'commitcamp', description: undefined, teamId: TEAM, databaseType: 'RELATIONAL' });
    expect(errors).toHaveLength(0);
  });

  it('accepts what the CLI sends', async () => {
    const errors = await errorsFor({ name: 'commitcamp', teamId: TEAM });
    expect(errors).toHaveLength(0);
  });

  it('refuses a body without a team', async () => {
    const errors = await errorsFor({ name: 'commitcamp' });
    expect(errors.map((e) => e.property)).toContain('teamId');
  });

  it('refuses an unknown database model', async () => {
    const errors = await errorsFor({ name: 'commitcamp', teamId: TEAM, databaseType: 'GRAPH' });
    expect(errors.map((e) => e.property)).toContain('databaseType');
  });

  it('refuses a field it does not know, so nothing reaches the service unchecked', async () => {
    const errors = await errorsFor({ name: 'commitcamp', teamId: TEAM, plan: 'pro' });
    expect(errors.map((e) => e.property)).toContain('plan');
  });

  it('accepts the full New project dialog body', async () => {
    const errors = await errorsFor({
      name: 'commitcamp',
      teamId: TEAM,
      databaseType: 'RELATIONAL',
      dbPassword: 'Str0ng-Passw0rd!',
      computeTier: 'shared',
      region: 'eu-central',
      dataAccess: { dataApi: true, autoGrantNewTables: false, rlsOnNewTables: true },
    });
    expect(errors).toHaveLength(0);
  });

  it('treats an empty password as "generate one"', async () => {
    expect(await errorsFor({ name: 'commitcamp', teamId: TEAM, dbPassword: '' })).toHaveLength(0);
  });

  it('refuses an unknown compute tier or region', async () => {
    const tier = await errorsFor({ name: 'commitcamp', teamId: TEAM, computeTier: 'huge' });
    expect(tier.map((e) => e.property)).toContain('computeTier');
    const region = await errorsFor({ name: 'commitcamp', teamId: TEAM, region: 'fsn1' });
    expect(region.map((e) => e.property)).toContain('region');
  });

  it.each([
    ['too short', 'Ab1!short'],
    ['with a space', 'Abcdef 12345!'],
    ['without digits', 'Abcdefghijkl!'],
    ['without letters', '1234567890123!'],
    ['too long', 'A1' + 'x'.repeat(127)],
  ])('refuses a password %s', async (_label, dbPassword) => {
    const errors = await errorsFor({ name: 'commitcamp', teamId: TEAM, dbPassword });
    expect(errors.map((e) => e.property)).toContain('dbPassword');
  });

  it('refuses data access flags that are not booleans or are missing', async () => {
    const wrong = await errorsFor({
      name: 'commitcamp',
      teamId: TEAM,
      dataAccess: { dataApi: 'yes', autoGrantNewTables: true, rlsOnNewTables: false },
    });
    expect(wrong.map((e) => e.property)).toContain('dataAccess');
    const missing = await errorsFor({ name: 'commitcamp', teamId: TEAM, dataAccess: { dataApi: true } });
    expect(missing.map((e) => e.property)).toContain('dataAccess');
  });
});
