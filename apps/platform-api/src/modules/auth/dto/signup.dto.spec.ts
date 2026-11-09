import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignupDto } from './signup.dto';

const base = { email: 'a@b.co', password: 'Passw0rd!x' };
const errorsFor = (body: object) => validate(plainToInstance(SignupDto, body));

describe('SignupDto terms acceptance', () => {
  it('accepts acceptedTerms: true', async () => {
    expect(await errorsFor({ ...base, acceptedTerms: true })).toHaveLength(0);
  });
  it.each([[{}], [{ acceptedTerms: false }], [{ acceptedTerms: 'true' }]])('rejects %j', async (extra) => {
    const errs = await errorsFor({ ...base, ...extra });
    expect(errs.map((e) => e.property)).toContain('acceptedTerms');
  });
});
