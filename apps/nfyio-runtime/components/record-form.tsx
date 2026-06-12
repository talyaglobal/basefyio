'use client';
import { useState } from 'react';
import { Field } from '../lib/types';

interface Props {
  tableName: string;
  fields: Field[];
  onSubmit?: (data: Record<string, string>) => void;
}

export function RecordForm({ tableName, fields, onSubmit }: Props) {
  const editableFields = fields.filter((f) => !f.primaryKey && !['created_at', 'updated_at'].includes(f.name));
  const [values, setValues] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.(values);
  };

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 600, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {editableFields.map((field) => (
        <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <label style={{ fontSize: '0.875rem', fontWeight: 500, color: '#374151' }}>
            {field.description || field.name}
            {!field.nullable && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
          </label>
          <input
            type={field.type === 'number' ? 'number' : field.type === 'boolean' ? 'checkbox' : 'text'}
            value={values[field.name] || ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
            required={!field.nullable}
            placeholder={field.description || field.name}
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.875rem',
              outline: 'none',
            }}
          />
        </div>
      ))}
      <button
        type="submit"
        style={{
          padding: '0.6rem 1.5rem',
          background: '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        Save
      </button>
    </form>
  );
}
