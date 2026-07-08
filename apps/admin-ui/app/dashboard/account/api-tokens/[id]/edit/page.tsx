import { ApiTokenCreate } from '@/components/api-token-create';

export default function ApiTokenEditPage({ params }: { params: { id: string } }) {
  return <ApiTokenCreate tokenId={params.id} />;
}
