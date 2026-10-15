/**
 * SQLite column factories retaining the existing schema's domain names.
 * Dates are UTC epoch microseconds; arrays and objects are JSON text.
 */
import { sql, type HasDefault, type BuildColumns } from "drizzle-orm";
import {
  integer as sqliteInteger, text as sqliteText, real, customType, sqliteTable, check,
  type SQLiteColumnBuilderBase, type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";
export { primaryKey, unique, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";

const wideIntegers = new WeakSet<object>();
export function pgTable<TName extends string, TColumns extends Record<string, SQLiteColumnBuilderBase>>(
  name: TName,
  columns: TColumns,
  extra?: (table: BuildColumns<TName, TColumns, "sqlite">) => SQLiteTableExtraConfigValue[],
) {
  return sqliteTable(name, columns, (table) => [
    ...(extra?.(table) ?? []),
    ...Object.entries(columns).flatMap(([key, builder]) => {
      const column = table[key]!;
      if (column.columnType !== "SQLiteInteger") return [];
      // Preserve PostgreSQL's int32 overflow protection even for SQL arithmetic,
      // not just bound parameters. The single bigint column remains int64-safe.
      const limit = wideIntegers.has(builder) ? Number.MAX_SAFE_INTEGER : 2_147_483_647;
      const minimum = wideIntegers.has(builder) ? -Number.MAX_SAFE_INTEGER : -2_147_483_648;
      return [check(`${name}_${column.name}_range`, sql`${column} BETWEEN ${sql.raw(String(minimum))} AND ${sql.raw(String(limit))}`)];
    }),
  ]);
}

export function text(name: string) {
  return Object.assign(sqliteText(name), {
    array: () => sqliteText(name, { mode: "json" }).$type<string[]>(),
  });
}
export function integer(name: string) {
  return Object.assign(sqliteInteger(name), {
    array: () => sqliteText(name, { mode: "json" }).$type<number[]>(),
  });
}
export function serial(name: string) {
  const builder = sqliteInteger(name);
  const primaryKey = builder.primaryKey.bind(builder);
  return Object.assign(builder, { primaryKey: () => primaryKey({ autoIncrement: true }) });
}
export function bigint(name: string, _options?: { mode: "number" }) {
  const builder = sqliteInteger(name);
  wideIntegers.add(builder);
  return builder;
}
export const numeric = (name: string, _options?: unknown) => real(name);
export const boolean = (name: string) => sqliteInteger(name, { mode: "boolean" });
export const jsonb = (name: string) => sqliteText(name, { mode: "json" });
const microsecondTimestamp = customType<{ data: Date; driverData: number }>({
  dataType: () => "integer",
  fromDriver: (value) => new Date(value / 1000),
  toDriver: (value) => {
    const encoded = value.getTime() * 1000;
    if (!Number.isSafeInteger(encoded)) throw new Error("Timestamp is outside the supported SQLite range");
    return encoded;
  },
});
export function timestamp(name: string, _options?: { withTimezone?: boolean }) {
  const builder = microsecondTimestamp(name);
  return Object.assign(builder, {
    defaultNow<T extends typeof builder>(this: T): HasDefault<T> {
      return this.default(sql`(cast(unixepoch('subsec') * 1000000 as integer))`) as HasDefault<T>;
    },
  });
}
