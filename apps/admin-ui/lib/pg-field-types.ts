import {
  Fingerprint,
  Hash,
  ArrowUp01,
  ArrowUpDown,
  Type,
  Text,
  ToggleLeft,
  Calendar,
  CalendarClock,
  CalendarDays,
  Clock,
  Sigma,
  Gauge,
  Braces,
  Code,
  Binary,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type FieldCategory =
  | 'ID & Keys'
  | 'Numbers'
  | 'Text'
  | 'Date & Time'
  | 'Boolean'
  | 'JSON'
  | 'Binary';

export interface PgFieldType {
  value: string;
  label: string;
  description: string;
  icon: LucideIcon;
  category: FieldCategory;
}

export const FIELD_CATEGORIES: FieldCategory[] = [
  'ID & Keys',
  'Numbers',
  'Text',
  'Date & Time',
  'Boolean',
  'JSON',
  'Binary',
];

export const PG_FIELD_TYPES: PgFieldType[] = [
  // ID & Keys
  { value: 'uuid', label: 'UUID', description: 'Auto-generated unique ID', icon: Fingerprint, category: 'ID & Keys' },
  { value: 'serial', label: 'Serial', description: 'Auto-increment integer (1, 2, 3...)', icon: ArrowUp01, category: 'ID & Keys' },
  { value: 'bigserial', label: 'Big Serial', description: 'Auto-increment large integer', icon: ArrowUp01, category: 'ID & Keys' },

  // Numbers
  { value: 'integer', label: 'Integer', description: 'Whole number (-2B to 2B)', icon: Hash, category: 'Numbers' },
  { value: 'bigint', label: 'Big Integer', description: 'Large whole number', icon: Hash, category: 'Numbers' },
  { value: 'smallint', label: 'Small Integer', description: 'Small whole number (-32K to 32K)', icon: Hash, category: 'Numbers' },
  { value: 'numeric', label: 'Numeric', description: 'Exact decimal (money, precision math)', icon: Sigma, category: 'Numbers' },
  { value: 'real', label: 'Float', description: 'Approximate decimal (6 digits)', icon: Gauge, category: 'Numbers' },
  { value: 'double precision', label: 'Double', description: 'High-precision decimal (15 digits)', icon: Gauge, category: 'Numbers' },

  // Text
  { value: 'text', label: 'Text', description: 'Unlimited length text', icon: Type, category: 'Text' },
  { value: 'varchar(255)', label: 'Varchar(255)', description: 'Text up to 255 characters', icon: Text, category: 'Text' },

  // Date & Time
  { value: 'timestamptz', label: 'Timestamp (TZ)', description: 'Date + time with timezone', icon: CalendarClock, category: 'Date & Time' },
  { value: 'timestamp', label: 'Timestamp', description: 'Date + time without timezone', icon: CalendarClock, category: 'Date & Time' },
  { value: 'date', label: 'Date', description: 'Date only (year-month-day)', icon: CalendarDays, category: 'Date & Time' },
  { value: 'time', label: 'Time', description: 'Time only (hour:min:sec)', icon: Clock, category: 'Date & Time' },

  // Boolean
  { value: 'boolean', label: 'Boolean', description: 'True or false', icon: ToggleLeft, category: 'Boolean' },

  // JSON
  { value: 'jsonb', label: 'JSONB', description: 'Binary JSON (searchable, indexed)', icon: Braces, category: 'JSON' },
  { value: 'json', label: 'JSON', description: 'Raw JSON text', icon: Code, category: 'JSON' },

  // Binary
  { value: 'bytea', label: 'Binary', description: 'Raw binary data', icon: Binary, category: 'Binary' },
];

export const DEFAULT_SUGGESTIONS: Record<string, string[]> = {
  uuid: ['gen_random_uuid()'],
  timestamptz: ['now()', 'CURRENT_TIMESTAMP'],
  timestamp: ['now()', 'CURRENT_TIMESTAMP'],
  boolean: ['true', 'false'],
};

export function getFieldType(value: string): PgFieldType | undefined {
  return PG_FIELD_TYPES.find((t) => t.value === value);
}
