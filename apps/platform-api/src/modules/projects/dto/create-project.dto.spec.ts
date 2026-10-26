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
    const errors = await errorsFor({ name: 'commitcamp', teamId: TEAM, region: 'fsn1' });
    expect(errors.map((e) => e.property)).toContain('region');
  });
});
