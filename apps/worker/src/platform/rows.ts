// Reading a ProjectStore row's columns. A column of the wrong type is a
// broken invariant of our own schema, so it throws, naming the column. Pure.

/** A text column's value. */
export function rowText(value: SqlStorageValue | undefined, column: string): string {
  if (typeof value !== "string") throw new Error(`${column} is not text`);
  return value;
}

/** A number column's value. */
export function rowNumber(value: SqlStorageValue | undefined, column: string): number {
  if (typeof value !== "number") throw new Error(`${column} is not a number`);
  return value;
}

/** A nullable text column's value. */
export function rowTextOrNull(value: SqlStorageValue | undefined, column: string): string | null {
  return value === null ? null : rowText(value, column);
}

/** A nullable number column's value. */
export function rowNumberOrNull(value: SqlStorageValue | undefined, column: string): number | null {
  return value === null ? null : rowNumber(value, column);
}

/**
 * The export cursor of a page read with `rowid AS row_id ... LIMIT limit`:
 * the last row's rowid when the page is full, else null, since a short page
 * is the last (privacy-25).
 */
export function exportCursor(
  page: readonly Record<string, SqlStorageValue>[],
  limit: number,
): number | null {
  if (page.length === 0 || page.length !== limit) return null;
  return rowNumber(page.at(-1)?.row_id, "rowid");
}

/** What a table's export writes per row: its columns in order, and which hold JSON text (privacy-22). */
export interface ExportShape {
  table: string;
  columns: readonly string[];
  json: readonly string[];
}

/**
 * Import lines (privacy-30, privacy-31) as rows of `shape.columns`, in order:
 * each line a JSON object with exactly those keys, its JSON columns turned
 * back into text and every other value a string, number or null. Anything
 * else is the first bad line, counted from 1, and why.
 */
export function importRowsOf(
  shape: ExportShape,
  lines: readonly unknown[],
): { ok: true; rows: SqlStorageValue[][] } | { ok: false; line: number; reason: string } {
  const expected = [...shape.columns].toSorted().join(",");
  const rows: SqlStorageValue[][] = [];
  for (const [index, line] of lines.entries()) {
    const bad = (reason: string) => ({ ok: false as const, line: index + 1, reason });
    if (typeof line !== "string") return bad("it is not text");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return bad("it is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return bad("it is not a JSON object");
    }
    const object = Object.fromEntries(Object.entries(parsed));
    if (Object.keys(object).toSorted().join(",") !== expected) {
      return bad(`its columns are not ${shape.table}'s: ${shape.columns.join(", ")}`);
    }
    const row: SqlStorageValue[] = [];
    for (const column of shape.columns) {
      const value: unknown = object[column];
      if (shape.json.includes(column)) row.push(JSON.stringify(value));
      else if (value === null || typeof value === "string" || typeof value === "number")
        row.push(value);
      else return bad(`${column} is not text, a number or null`);
    }
    rows.push(row);
  }
  return { ok: true, rows };
}
