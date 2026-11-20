import { BadRequestException } from '@nestjs/common';
import { ProjectSdkAuthController } from './project-sdk-auth.controller';

describe('ProjectSdkAuthController.signin validation', () => {
  const signin = jest.fn().mockResolvedValue({ ok: true });
  const controller = new ProjectSdkAuthController({ signin } as any, {} as any, {} as any);
  const req: any = { apiKeyPayload: { projectId: 'p1' }, ip: '1.2.3.4', socket: {} };

  beforeEach(() => signin.mockClear());

  it.each([undefined, {}, { email: 'a@b.co' }, { password: 'x' }, { email: 5, password: 'x' }, { email: '  ', password: 'x' }])(
    'answers 400 for %j',
    async (body) => {
      await expect(controller.signin(req, body as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(signin).not.toHaveBeenCalled();
    },
  );

  it('passes a valid body through', async () => {
    await controller.signin(req, { email: 'a@b.co', password: 'x' });
    expect(signin).toHaveBeenCalled();
  });
});
