'use client';

import { InfraCostsTab } from '@/components/infra-costs-tab';
import { PageHeader } from '@/components/console/ui';

export default function ConsoleCostsPage() {
  return (
    <>
      <PageHeader
        title="Infrastructure costs"
        description="The server bill, the pricing model behind every project's cost, and margin per team"
      />
      <InfraCostsTab />
    </>
  );
}
