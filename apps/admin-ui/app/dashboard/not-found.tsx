import { NotFoundView } from '@/components/not-found-view';

/**
 * Unknown dashboard pages (and notFound() calls such as an unknown changelog
 * entry) render here, inside the dashboard header and sidebar.
 */
export default function DashboardNotFound() {
  return <NotFoundView />;
}
