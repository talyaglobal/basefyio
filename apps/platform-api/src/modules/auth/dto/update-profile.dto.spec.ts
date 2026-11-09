import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

const errors = (body: object) => validateSync(plainToInstance(UpdateProfileDto, body));

describe('UpdateProfileDto', () => {
  it('rejects a blank first name', () => {
    expect(errors({ firstName: '' })).toHaveLength(1);
    expect(errors({ firstName: '   ' })).toHaveLength(1);
  });
  it('accepts a name, and a body without one', () => {
    expect(errors({ firstName: 'Ada' })).toHaveLength(0);
    expect(errors({ lastName: '' })).toHaveLength(0);
  });
});
