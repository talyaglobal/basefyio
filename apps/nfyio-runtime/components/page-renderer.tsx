import { Table, Page } from '../lib/types';
import { ListTable } from './list-table';

interface Props {
  page: Page;
  table: Table;
  rows?: Record<string, unknown>[];
}

/** Top-level dispatcher: renders the correct UI based on page.type */
export function PageRenderer({ page, table, rows = [] }: Props) {
  if (page.type === 'list') {
    return <ListTable table={table} rows={rows} />;
  }
  return (
    <div style={{ color: '#94a3b8', padding: '2rem' }}>
      Page type &quot;{page.type}&quot; not yet rendered by PageRenderer (use dedicated route components)
    </div>
  );
}
