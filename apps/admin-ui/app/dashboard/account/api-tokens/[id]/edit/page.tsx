import { ApiTokenCreate } from '@/components/api-token-create';

export default async function ApiTokenEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApiTokenCreate tokenId={id} />;
}
