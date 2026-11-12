'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Field definitions for a Data Engine entity. Simple fields (a name, a type,
 * required) are edited as rows; nested objects with their own fields are
 * edited as JSON. Documents are validated against these fields on every
 * write; documents already stored stay readable when the fields change.
 */

export interface SimpleFieldRow {
  name: string;
  type: string;
  required: boolean;
}

/** Row types: scalar types, `<type>[]` for arrays of a scalar, and a free-form object. */
export const FIELD_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'json', label: 'Any JSON' },
  { value: 'text[]', label: 'List of text' },
  { value: 'number[]', label: 'List of numbers' },
  { value: 'object', label: 'Object (any fields)' },
];

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

type Field = Record<string, unknown>;

/** Row → field definition accepted by the API. */
export function rowToField(row: SimpleFieldRow): Field {
  const base = { name: row.name.trim(), required: row.required };
  if (row.type === 'object') return { ...base, kind: 'object' };
  if (row.type.endsWith('[]')) {
    return { ...base, kind: 'array', itemSchema: { name: 'item', kind: 'scalar', type: row.type.slice(0, -2) } };
  }
  return { ...base, kind: 'scalar', type: row.type };
}

/** Field definitions → rows, or null when any field needs the JSON editor. */
export function fieldsToRows(fields: unknown[]): SimpleFieldRow[] | null {
  const rows: SimpleFieldRow[] = [];
  for (const raw of fields) {
    const f = raw as Field;
    const required = f.required === true;
    const name = typeof f.name === 'string' ? f.name : '';
    if (f.kind === 'scalar' || f.kind === undefined) {
      const type = typeof f.type === 'string' ? f.type : 'json';
      if (!FIELD_TYPE_OPTIONS.some((o) => o.value === type)) return null;
      if (Array.isArray(f.validationRules) && f.validationRules.length > 0) return null;
      rows.push({ name, type, required });
    } else if (f.kind === 'array') {
      const item = f.itemSchema as Field | undefined;
      const t = item && item.kind === 'scalar' ? `${String(item.type)}[]` : null;
      if (!t || !FIELD_TYPE_OPTIONS.some((o) => o.value === t)) return null;
      rows.push({ name, type: t, required });
    } else if (f.kind === 'object' && !(Array.isArray(f.children) && f.children.length > 0)) {
      rows.push({ name, type: 'object', required });
    } else {
      return null;
    }
  }
  return rows;
}

/** Validate rows; returns an error message or null. */
export function validateRows(rows: SimpleFieldRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) return 'Every field needs a name';
    if (!FIELD_NAME_RE.test(name)) {
      return `Field "${name}": use letters, digits and underscores, starting with a letter`;
    }
    if (seen.has(name)) return `Field "${name}" is defined twice`;
    seen.add(name);
  }
  return null;
}

export interface FieldsEditorValue {
  mode: 'rows' | 'json';
  rows: SimpleFieldRow[];
  json: string;
}

export function initialFieldsValue(fields: unknown[]): FieldsEditorValue {
  const rows = fieldsToRows(fields);
  return rows
    ? { mode: 'rows', rows, json: JSON.stringify(fields, null, 2) }
    : { mode: 'json', rows: [], json: JSON.stringify(fields, null, 2) };
}

/** Resolve the editor value to field definitions, or throw an Error with a readable message. */
export function resolveFields(value: FieldsEditorValue): unknown[] {
  if (value.mode === 'rows') {
    const rows = value.rows.filter((r) => r.name.trim() !== '' || r.required);
    const error = validateRows(rows);
    if (error) throw new Error(error);
    return rows.map(rowToField);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.json || '[]');
  } catch {
    throw new Error('Fields must be valid JSON — an array of field definitions');
  }
  if (!Array.isArray(parsed)) throw new Error('Fields must be a JSON array of field definitions');
  return parsed;
}

export function EntityFieldsEditor({
  value,
  onChange,
}: {
  value: FieldsEditorValue;
  onChange: (v: FieldsEditorValue) => void;
}) {
  const [jsonError, setJsonError] = useState<string | null>(null);

  function switchMode(mode: 'rows' | 'json') {
    if (mode === value.mode) return;
    if (mode === 'json') {
      const rows = value.rows.filter((r) => r.name.trim() !== '');
      onChange({ ...value, mode, json: JSON.stringify(rows.map(rowToField), null, 2) });
      return;
    }
    try {
      const parsed = JSON.parse(value.json || '[]');
      const rows = Array.isArray(parsed) ? fieldsToRows(parsed) : null;
      if (!rows) {
        setJsonError('These fields use nested objects or rules — keep editing them as JSON');
        return;
      }
      setJsonError(null);
      onChange({ ...value, mode, rows });
    } catch {
      setJsonError('Fix the JSON before switching to the simple editor');
    }
  }

  const updateRow = (i: number, patch: Partial<SimpleFieldRow>) =>
    onChange({ ...value, rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Fields</p>
        <div className="flex gap-1 text-xs" role="tablist" aria-label="Field editor mode">
          {(['rows', 'json'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={value.mode === m}
              onClick={() => switchMode(m)}
              className={`rounded px-2 py-0.5 ${value.mode === m ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {m === 'rows' ? 'Simple' : 'JSON'}
            </button>
          ))}
        </div>
      </div>

      {value.mode === 'rows' ? (
        <div className="space-y-1.5">
          {value.rows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No fields yet — documents can hold any JSON. Add fields to have every write validated.
            </p>
          )}
          {value.rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_150px_auto_32px] items-center gap-2">
              <Input
                className="h-8 text-xs font-mono"
                placeholder="fieldName"
                aria-label={`Field ${i + 1} name`}
                value={row.name}
                onChange={(e) => updateRow(i, { name: e.target.value })}
              />
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                aria-label={`Field ${i + 1} type`}
                value={row.type}
                onChange={(e) => updateRow(i, { type: e.target.value })}
              >
                {FIELD_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) => updateRow(i, { required: e.target.checked })}
                />
                Required
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`Remove field ${row.name || i + 1}`}
                onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onChange({ ...value, rows: [...value.rows, { name: '', type: 'text', required: false }] })}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add field
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <textarea
            className="w-full h-48 rounded-md border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label="Fields as JSON"
            value={value.json}
            onChange={(e) => onChange({ ...value, json: e.target.value })}
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground">
            An array of fields, e.g.{' '}
            <code>{'[{"name":"address","kind":"object","children":[{"name":"city","kind":"scalar","type":"text","required":true}]}]'}</code>
          </p>
        </div>
      )}
      {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
    </div>
  );
}
