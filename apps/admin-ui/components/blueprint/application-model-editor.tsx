'use client';

import { useState } from 'react';

interface NavItem {
  label: string;
  table: string;
  icon?: string;
}

interface RolePermissions {
  [table: string]: string[]; // ['read', 'write', 'delete']
}

interface Role {
  name: string;
  permissions: RolePermissions;
}

interface ApplicationModel {
  name: string;
  navigation: NavItem[];
  roles: Role[];
}

interface Props {
  blueprintId: string;
  initialModel: ApplicationModel;
  tables: Array<{ name: string; displayName: string }>;
  onSaved?: (model: ApplicationModel) => void;
}

export function ApplicationModelEditor({ blueprintId, initialModel, tables, onSaved }: Props) {
  const [model, setModel] = useState<ApplicationModel>({
    name: initialModel.name ?? 'My App',
    navigation: initialModel.navigation ?? [],
    roles: initialModel.roles ?? [],
  });
  const [activeTab, setActiveTab] = useState<'info' | 'navigation' | 'roles'>('info');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/blueprint/${blueprintId}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        onSaved?.(model);
      }
    } finally {
      setSaving(false);
    }
  };

  const tabStyle = (tab: string) =>
    ({
      padding: '0.5rem 1rem',
      border: 'none',
      background: activeTab === tab ? '#3b82f6' : 'transparent',
      color: activeTab === tab ? '#fff' : '#64748b',
      borderRadius: 6,
      cursor: 'pointer',
      fontWeight: activeTab === tab ? 600 : 400,
      fontSize: '0.875rem',
    }) as React.CSSProperties;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
        {(['info', 'navigation', 'roles'] as const).map((tab) => (
          <button key={tab} style={tabStyle(tab)} onClick={() => setActiveTab(tab)}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Info tab */}
      {activeTab === 'info' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>App Name</span>
            <input
              value={model.name}
              onChange={(e) => setModel((m) => ({ ...m, name: e.target.value }))}
              style={{ padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.875rem' }}
            />
          </label>
        </div>
      )}

      {/* Navigation tab */}
      {activeTab === 'navigation' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ fontSize: '0.875rem', color: '#64748b' }}>
            Drag to reorder · Edit labels · Remove unwanted pages
          </div>
          {model.navigation.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <input
                value={item.label}
                onChange={(e) =>
                  setModel((m) => ({
                    ...m,
                    navigation: m.navigation.map((n, j) => (j === i ? { ...n, label: e.target.value } : n)),
                  }))
                }
                style={{
                  flex: 1,
                  padding: '0.4rem 0.75rem',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                }}
                placeholder="Label"
              />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', minWidth: 80 }}>{item.table}</span>
              <button
                onClick={() => setModel((m) => ({ ...m, navigation: m.navigation.filter((_, j) => j !== i) }))}
                style={{
                  padding: '0.25rem 0.5rem',
                  border: '1px solid #fecaca',
                  background: '#fff',
                  borderRadius: 4,
                  color: '#ef4444',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {/* Add missing tables */}
          {tables
            .filter((t) => !model.navigation.some((n) => n.table === t.name))
            .map((t) => (
              <button
                key={t.name}
                onClick={() =>
                  setModel((m) => ({ ...m, navigation: [...m.navigation, { label: t.displayName, table: t.name }] }))
                }
                style={{
                  padding: '0.4rem 0.75rem',
                  border: '1px dashed #94a3b8',
                  background: '#f8fafc',
                  borderRadius: 6,
                  color: '#64748b',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  textAlign: 'left',
                }}
              >
                + Add {t.displayName}
              </button>
            ))}
        </div>
      )}

      {/* Roles tab */}
      {activeTab === 'roles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {model.roles.map((role, ri) => (
            <div key={ri} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.75rem', color: '#1e293b' }}>{role.name}</div>
              <div
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.5rem' }}
              >
                {tables.map((t) => {
                  const perms = role.permissions[t.name] ?? [];
                  const hasRead = perms.includes('read');
                  const hasWrite = perms.includes('write');
                  return (
                    <div key={t.name} style={{ background: '#f8fafc', borderRadius: 6, padding: '0.5rem' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>{t.displayName}</div>
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={hasRead}
                          onChange={(e) => {
                            const newPerms = e.target.checked
                              ? [...perms, 'read']
                              : perms.filter((p) => p !== 'read' && p !== 'write' && p !== 'delete');
                            setModel((m) => ({
                              ...m,
                              roles: m.roles.map((r, j) =>
                                j === ri ? { ...r, permissions: { ...r.permissions, [t.name]: newPerms } } : r,
                              ),
                            }));
                          }}
                        />
                        Read
                      </label>
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={hasWrite}
                          onChange={(e) => {
                            const newPerms = e.target.checked
                              ? [...new Set([...perms, 'read', 'write'])]
                              : perms.filter((p) => p !== 'write' && p !== 'delete');
                            setModel((m) => ({
                              ...m,
                              roles: m.roles.map((r, j) =>
                                j === ri ? { ...r, permissions: { ...r.permissions, [t.name]: newPerms } } : r,
                              ),
                            }));
                          }}
                        />
                        Write
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <button
            onClick={() =>
              setModel((m) => ({
                ...m,
                roles: [...m.roles, { name: `role_${m.roles.length + 1}`, permissions: {} }],
              }))
            }
            style={{
              padding: '0.5rem 1rem',
              border: '1px dashed #94a3b8',
              background: '#f8fafc',
              borderRadius: 6,
              color: '#64748b',
              cursor: 'pointer',
              fontSize: '0.875rem',
              alignSelf: 'flex-start',
            }}
          >
            + Add Role
          </button>
        </div>
      )}

      {/* Save button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.5rem', borderTop: '1px solid #e2e8f0' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '0.6rem 1.5rem',
            background: saved ? '#10b981' : '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: '0.875rem',
            transition: 'background 0.2s',
          }}
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save & Approve'}
        </button>
      </div>
    </div>
  );
}
