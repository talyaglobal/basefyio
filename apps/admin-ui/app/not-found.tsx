import { NotFoundView } from '@/components/not-found-view';

/** Any URL that matches no route outside the dashboard: a branded 404 with a way back. */
export default function NotFound() {
  return <NotFoundView fullPage />;
}
