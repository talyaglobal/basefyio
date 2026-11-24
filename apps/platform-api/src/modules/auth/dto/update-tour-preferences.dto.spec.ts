import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  TOUR_ID_MAX_LENGTH,
  TOUR_ID_PATTERN,
  TOUR_MARK_BATCH_MAX,
  UpdateTourPreferencesDto,
} from './update-tour-preferences.dto';

const errors = (body: object, opts = {}) => validateSync(plainToInstance(UpdateTourPreferencesDto, body), opts);

describe('UpdateTourPreferencesDto', () => {
  it('accepts an empty body and every valid field', () => {
    expect(errors({})).toHaveLength(0);
    expect(errors({ autoEnabled: false })).toHaveLength(0);
    expect(errors({ markSeen: ['project-sql', 'projects.v2'] })).toHaveLength(0);
    expect(errors({ resetSeen: true, autoEnabled: true })).toHaveLength(0);
  });

  it('accepts a full batch of the longest ids', () => {
    const ids = Array.from({ length: TOUR_MARK_BATCH_MAX }, (_, i) => `${i}`.padEnd(TOUR_ID_MAX_LENGTH, 'a'));
    expect(errors({ markSeen: ids })).toHaveLength(0);
  });

  it('rejects a string boolean (no implicit conversion)', () => {
    expect(errors({ autoEnabled: 'false' })).toHaveLength(1);
    expect(errors({ resetSeen: 'true' })).toHaveLength(1);
  });

  it('rejects an explicit null (only an absent field is optional)', () => {
    expect(errors({ autoEnabled: null })).toHaveLength(1);
    expect(errors({ resetSeen: null })).toHaveLength(1);
    expect(errors({ markSeen: null })).toHaveLength(1);
  });

  it('rejects a markSeen that is not an array, or too long', () => {
    expect(errors({ markSeen: 'projects' })).toHaveLength(1);
    expect(errors({ markSeen: Array.from({ length: TOUR_MARK_BATCH_MAX + 1 }, (_, i) => `t${i}`) })).toHaveLength(1);
  });

  it('rejects ids that are too long or badly formed', () => {
    for (const bad of ['a'.repeat(TOUR_ID_MAX_LENGTH + 1), 'Project SQL', '../x', '', '<script>', 7]) {
      expect(errors({ markSeen: ['projects', bad] })).toHaveLength(1);
    }
  });

  it('rejects an unknown key under the global pipe options', () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    expect(errors({ seen: ['projects'] }, opts)).toHaveLength(1);
    expect(errors({ autoEnabled: true }, opts)).toHaveLength(0);
  });

  it('exports a pattern that matches registry-style ids only', () => {
    expect(TOUR_ID_PATTERN.test('project-api-explorer')).toBe(true);
    expect(TOUR_ID_PATTERN.test('projects.v2')).toBe(true);
    expect(TOUR_ID_PATTERN.test('project_sql')).toBe(false);
    expect(TOUR_ID_PATTERN.test('-projects')).toBe(false);
    expect(TOUR_ID_PATTERN.test('projects..v2')).toBe(false);
  });
});
