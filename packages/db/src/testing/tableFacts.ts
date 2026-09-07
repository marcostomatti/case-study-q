/**
 * Reads a Drizzle table back as plain data, so a suite can assert what the
 * migration will actually emit.
 *
 * This exists because the two things a schema module decides are checked by
 * different mechanisms, and only one of them is a type:
 *
 *   - The **TypeScript property names and their types** are `$inferSelect` /
 *     `$inferInsert`, pinned in the colocated `*.test-d.ts` files. `tsc` reads
 *     those (the leaf tsconfig excludes `**\/*.test.ts`, not `*.test-d.ts`), so
 *     `bun run check-types` is the gate that fails on a drift.
 *   - The **SQL names, types, nullability and keys** are erased from every
 *     inferred type. `Company` says `registeredLegalName: string` whether the
 *     column is `registered_legal_name`, `legal_name` or `name`. Only the
 *     runtime table object knows, and that is what this module surfaces.
 *
 * The second half is the one this stage turns on. The column names here are
 * deliberately unlike the contract's field names so that `service-a`'s mapping
 * layer has something real to translate (spec §2.1) — a claim no type
 * assertion can make, and one a well-meaning rename would quietly erase.
 *
 * Nothing here decides what the right answer is: it reshapes Drizzle's own
 * introspection API and leaves every expected value to be spelled out
 * literally in the suite. A helper that knew the answer would agree with
 * itself whatever the schema said.
 */
import type { Table } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

export interface ColumnFacts {
  /** The column name `CREATE TABLE` writes — not the TypeScript property. */
  sqlName: string;
  /** The rendered SQL type, length, enum name and time zone included. */
  sqlType: string;
  notNull: boolean;
  /** True when the database fills the column, which makes it optional on insert. */
  hasDefault: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
}

export interface ForeignKeyFacts {
  /** Columns on this table, in the order the constraint declares them. */
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string | undefined;
}

/**
 * Keyed by **TypeScript property name**, valued by what that property becomes
 * in SQL. That pairing is the rename itself, so asserting the whole record at
 * once also pins the column set: a column added or dropped fails the same
 * assertion rather than slipping past a per-column check.
 */
export const columnFacts = (table: Table): Record<string, ColumnFacts> => {
  const entries = Object.entries(getTableColumns(table)).map(([property, column]) => [
    property,
    {
      sqlName: column.name,
      sqlType: column.getSQLType(),
      notNull: column.notNull,
      hasDefault: column.hasDefault,
      isPrimaryKey: column.primary,
      isUnique: column.isUnique,
    },
  ]);

  return Object.fromEntries(entries) as Record<string, ColumnFacts>;
};

/** The table name as it reaches SQL, which need not match the exported binding. */
export const sqlTableName = (table: Table): string => getTableName(table);

/**
 * `getTableConfig` is Postgres-specific, hence the narrower parameter type.
 * `reference()` is a thunk because a table may point at one declared later in
 * the module graph; calling it here is what resolves that.
 */
export const foreignKeyFacts = (table: PgTable): ForeignKeyFacts[] => {
  const { foreignKeys } = getTableConfig(table);

  return foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();

    return {
      columns: reference.columns.map((column) => column.name),
      referencedTable: getTableName(reference.foreignTable),
      referencedColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
    };
  });
};
