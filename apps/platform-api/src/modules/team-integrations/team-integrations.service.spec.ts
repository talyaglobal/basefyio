import { of, throwError } from 'rxjs';
import { TeamIntegrationsService } from './team-integrations.service';

/** The status endpoint must not report a token GitHub has rejected as healthy. */
describe('TeamIntegrationsService.getGitHubStatus', () => {
  function make(get: jest.Mock, token: string | null = 'ghp_x') {
    const prisma: any = {
      team: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          githubOAuthToken: token,
          githubOAuthLogin: 'talyaglobal',
          githubOAuthAvatar: null,
        }),
      },
    };
    const config: any = { get: () => undefined };
    return new TeamIntegrationsService(prisma, config, { get } as any);
  }

  it('flags a token GitHub answers 401 to as expired', async () => {
    const svc = make(jest.fn().mockReturnValue(throwError(() => ({ response: { status: 401 } }))));
    expect(await svc.getGitHubStatus('t1')).toMatchObject({ connected: true, expired: true });
  });

  it('keeps a valid token as connected, not expired', async () => {
    const svc = make(jest.fn().mockReturnValue(of({ data: { login: 'talyaglobal' } })));
    expect(await svc.getGitHubStatus('t1')).toMatchObject({ connected: true, expired: false });
  });

  it('does not call a network failure an expired token', async () => {
    const svc = make(jest.fn().mockReturnValue(throwError(() => new Error('ETIMEDOUT'))));
    expect(await svc.getGitHubStatus('t1')).toMatchObject({ connected: true, expired: false });
  });

  it('does not call GitHub when no token is stored', async () => {
    const get = jest.fn();
    const svc = make(get, null);
    expect(await svc.getGitHubStatus('t1')).toMatchObject({ connected: false, expired: false });
    expect(get).not.toHaveBeenCalled();
  });
});
