import type { DataModel, Field } from '../schemas/data-model.schema.js';
import type { MigrationOperation, MigrationPlan, SafetyLevel } from './types.js';

function classifyTypeChange(from: string, to: string): SafetyLevel {
  const textLike = new Set(['string', 'text', 'json']);
  // int/number/boolean/date → string/text: POTENTIALLY_SAFE (USING cast usually works)
  if (textLike.has(to) && !textLike.has(from)) return 'POTENTIALLY_SAFE';
  // string/text → number/boolean/date: DESTRUCTIVE (data may not cast)
  return 'DESTRUCTIVE';
}

function classifyConstraintChange(v1: Field, v2: Field): SafetyLevel {
  if (v1.nullable && !v2.nullable) return 'DESTRUCTIVE'; // added NOT NULL
  if (!v1.nullable && v2.nullable) return 'SAFE';         // removed NOT NULL
  // unique changes handled separately as index ops
  return 'SAFE';
}

export function diffDataModels(v1: DataModel, v2: DataModel): MigrationPlan {
  const operations: MigrationOperation[] = [];
  const warnings: string[] = [];
  const breakingChanges: string[] = [];

  const v1Map = new Map(v1.tables.map(t => [t.name, t]));
  const v2Map = new Map(v2.tables.map(t => [t.name, t]));

  // Collections added / removed
  for (const [name] of v2Map) {
    if (!v1Map.has(name)) {
      operations.push({
        type: 'collection_added',
        safety: 'SAFE',
        collection: name,
        detail: `Collection "${name}" added`,
      });
    }
  }

  for (const [name] of v1Map) {
    if (!v2Map.has(name)) {
      operations.push({
        type: 'collection_removed',
        safety: 'DESTRUCTIVE',
        collection: name,
        detail: `Collection "${name}" removed — all data will be lost`,
      });
      breakingChanges.push(`Collection "${name}" removed`);
    }
  }

  // Field-level diff for tables present in both versions
  for (const [tableName, v1Table] of v1Map) {
    const v2Table = v2Map.get(tableName);
    if (!v2Table) continue;

    const v1Fields = new Map(v1Table.fields.map(f => [f.name, f]));
    const v2Fields = new Map(v2Table.fields.map(f => [f.name, f]));

    // Fields added
    for (const [name, field] of v2Fields) {
      if (v1Fields.has(name)) continue;
      const safety: SafetyLevel = field.nullable ? 'SAFE' : 'DESTRUCTIVE';
      operations.push({
        type: 'field_added',
        safety,
        collection: tableName,
        field: name,
        detail: `Field "${name}" added to "${tableName}"${!field.nullable ? ' (NOT NULL — requires DEFAULT for existing rows)' : ''}`,
      });
      if (!field.nullable) {
        warnings.push(
          `"${tableName}.${name}" is NOT NULL — existing rows will need a DEFAULT value or backfill`,
        );
      }
    }

    // Fields removed
    for (const [name] of v1Fields) {
      if (v2Fields.has(name)) continue;
      operations.push({
        type: 'field_removed',
        safety: 'DESTRUCTIVE',
        collection: tableName,
        field: name,
        detail: `Field "${name}" removed from "${tableName}" — column data will be lost`,
      });
      breakingChanges.push(`Field "${tableName}.${name}" removed`);
    }

    // Removed + added in same table with compatible type → possible rename; warn
    const removedNames = v1Table.fields
      .map(f => f.name)
      .filter(n => !v2Fields.has(n));
    const addedNames = v2Table.fields
      .map(f => f.name)
      .filter(n => !v1Fields.has(n));
    if (removedNames.length === 1 && addedNames.length === 1) {
      warnings.push(
        `"${tableName}": field "${removedNames[0]}" removed and "${addedNames[0]}" added — ` +
          `if this is a rename, use a field_renamed operation instead to preserve data`,
      );
    }

    // Changed fields
    for (const [name, v1Field] of v1Fields) {
      const v2Field = v2Fields.get(name);
      if (!v2Field) continue;

      // Type change
      if (v1Field.type !== v2Field.type) {
        const safety = classifyTypeChange(v1Field.type, v2Field.type);
        operations.push({
          type: 'field_type_changed',
          safety,
          collection: tableName,
          field: name,
          fromType: v1Field.type,
          toType: v2Field.type,
          detail: `"${tableName}.${name}" type changed: ${v1Field.type} → ${v2Field.type}`,
        });
        if (safety === 'DESTRUCTIVE') {
          breakingChanges.push(`"${tableName}.${name}" type: ${v1Field.type} → ${v2Field.type}`);
        }
      }

      // Unique constraint change → index_added / index_removed
      const v1Unique = v1Field.unique ?? false;
      const v2Unique = v2Field.unique ?? false;
      if (!v1Unique && v2Unique) {
        operations.push({
          type: 'index_added',
          safety: 'POTENTIALLY_SAFE',
          collection: tableName,
          field: name,
          detail: `Unique index added on "${tableName}.${name}" — will fail if duplicate values exist`,
        });
        warnings.push(
          `Unique index on "${tableName}.${name}" — verify no duplicate values exist before applying`,
        );
      } else if (v1Unique && !v2Unique) {
        operations.push({
          type: 'index_removed',
          safety: 'SAFE',
          collection: tableName,
          field: name,
          detail: `Unique index removed from "${tableName}.${name}"`,
        });
      }

      // Nullable constraint change (without type change)
      const nullableChanged = v1Field.nullable !== v2Field.nullable;
      if (nullableChanged) {
        const safety = classifyConstraintChange(v1Field, v2Field);
        operations.push({
          type: 'constraint_changed',
          safety,
          collection: tableName,
          field: name,
          detail: `"${tableName}.${name}" nullable: ${v1Field.nullable} → ${v2Field.nullable}`,
        });
        if (safety === 'DESTRUCTIVE') {
          breakingChanges.push(
            `"${tableName}.${name}" NOT NULL added — existing NULL rows will violate constraint`,
          );
        }
      }
    }
  }

  const hasDestructive = operations.some(op => op.safety === 'DESTRUCTIVE');
  return { operations, warnings, breakingChanges, hasDestructive };
}

/**
 * Build a field_renamed operation explicitly.
 * The caller is responsible for ensuring fromField + toField are the correct pair.
 */
export function makeRenameOp(
  collection: string,
  fromField: string,
  toField: string,
): MigrationOperation {
  return {
    type: 'field_renamed',
    safety: 'POTENTIALLY_SAFE',
    collection,
    fromField,
    toField,
    detail: `Field "${collection}.${fromField}" renamed to "${toField}" — data preserved via RENAME COLUMN`,
  };
}
