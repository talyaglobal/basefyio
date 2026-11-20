'use client';

import type { ProjectDataAccess } from '@/lib/types';

/** What every project had before the setting existed. */
export const DEFAULT_DATA_ACCESS: ProjectDataAccess = {
  dataApi: true,
  autoGrantNewTables: true,
  rlsOnNewTables: false,
};

const OPTIONS: Array<{
  key: keyof ProjectDataAccess;
  label: string;
  help: string;
  recommendation?: string;
}> = [
  {
    key: 'dataApi',
    label: 'Enable the Data API',
    help: 'Serve the tables in the public schema over REST with the project API keys. When it is off, the REST endpoints answer 403; the dashboard, the SQL editor, auth and storage keep working.',
  },
  {
    key: 'autoGrantNewTables',
    label: 'Grant API access to new tables automatically',
    help: 'New tables in the public schema are granted to the anon and authenticated roles, so the API keys can reach them (row-level security still applies). Tables that already exist keep their grants.',
    recommendation: 'We recommend turning this off to control access manually.',
  },
  {
    key: 'rlsOnNewTables',
    label: 'Enable row-level security on new tables',
    help: 'Every new table in the public schema starts with row-level security on, so no row is readable through the API keys until you add a policy.',
  },
];

/**
 * The three data access switches as native checkboxes, shared by the New project dialog
 * and Settings → Data access.
 */
export function DataAccessCheckboxes({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: ProjectDataAccess;
  onChange: (key: keyof ProjectDataAccess, checked: boolean) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="space-y-3">
      {OPTIONS.map((o) => {
        const id = `${idPrefix}-${o.key}`;
        return (
          <div key={o.key} className="flex items-start gap-3">
            <input
              id={id}
              type="checkbox"
              checked={value[o.key]}
              onChange={(e) => onChange(o.key, e.target.checked)}
              disabled={disabled}
              aria-describedby={`${id}-help`}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary disabled:opacity-50"
            />
            <div className="min-w-0 space-y-0.5">
              <label htmlFor={id} className="text-sm font-medium leading-tight">
                {o.label}
              </label>
              <p id={`${id}-help`} className="text-xs text-muted-foreground">
                {o.help}
                {o.recommendation && (
                  <>
                    {' '}
                    <strong className="font-semibold text-foreground">{o.recommendation}</strong>
                  </>
                )}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
