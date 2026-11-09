import { ForbiddenException } from '@nestjs/common';
import { BillingService } from './billing.service';

function makeService() {
  const service = new BillingService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  jest.spyOn(service, 'assertCanViewBilling').mockResolvedValue(undefined);
  jest.spyOn(service, 'getTeamSubscription').mockResolvedValue({ plan: { name: 'free' } });
  return service;
}

describe('getTeamSubscriptionForUser canManage', () => {
  it('is true for a caller who may change billing', async () => {
    const s = makeService();
    jest.spyOn(s, 'assertTeamOwner').mockResolvedValue(undefined);
    await expect(s.getTeamSubscriptionForUser('t', 'u')).resolves.toMatchObject({ plan: { name: 'free' }, canManage: true });
  });

  it('is false when the server would answer 403, so the UI shows the forms read-only', async () => {
    const s = makeService();
    jest.spyOn(s, 'assertTeamOwner').mockRejectedValue(new ForbiddenException('Only the team owner can manage billing'));
    await expect(s.getTeamSubscriptionForUser('t', 'u')).resolves.toMatchObject({ canManage: false });
  });
});
