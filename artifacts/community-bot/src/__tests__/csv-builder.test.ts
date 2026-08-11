/**
 * Unit tests for buildTempVcCsv.
 *
 * buildTempVcCsv is a pure function that converts TempVcDeletionRow[] into a
 * CSV string.  These tests confirm:
 *   1. The header row contains opted_out as the last column.
 *   2. A row with optedOut:true writes "true" in the opted_out column.
 *   3. A row with optedOut:false writes "false" in the opted_out column.
 *   4. All other columns (id, user_id, channel_id, joined_at, left_at,
 *      duration_seconds) are present and correct.
 *   5. Empty input returns only the header row.
 */

import { describe, it, expect } from "vitest";
import { buildTempVcCsv, type TempVcDeletionRow } from "../lib/community.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<TempVcDeletionRow> = {}): TempVcDeletionRow {
  const joinedAt = new Date("2025-03-01T10:00:00.000Z");
  const leftAt   = new Date("2025-03-01T10:01:30.000Z"); // 90 seconds later
  return {
    id:        42,
    guildId:   "guild-1",
    userId:    "user-abc",
    channelId: "chan-xyz",
    joinedAt,
    leftAt,
    optedOut:  false,
    ...overrides,
  };
}

/** Split a CSV string into an array of trimmed column arrays (one per line). */
function parseCsv(csv: string): string[][] {
  return csv.split("\n").map((line) => line.split(","));
}

/**
 * Minimal RFC 4180-compliant CSV row parser.
 * Handles double-quoted fields (including embedded commas and doubled quotes).
 * Returns an array of field strings for one CSV row.
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field: consume until the closing unescaped double-quote.
      let field = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ",") i++; // skip delimiter
    } else {
      // Unquoted field: consume until the next comma.
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("buildTempVcCsv", () => {
  // ── header row ─────────────────────────────────────────────────────────────

  it("includes opted_out as the last column in the header", () => {
    const csv = buildTempVcCsv([]);
    const [header] = parseCsv(csv);
    expect(header?.at(-1)).toBe("opted_out");
  });

  it("header contains all expected columns in the correct order", () => {
    const csv = buildTempVcCsv([]);
    const [header] = parseCsv(csv);
    expect(header).toEqual([
      "id",
      "user_id",
      "channel_id",
      "joined_at",
      "left_at",
      "duration_seconds",
      "opted_out",
    ]);
  });

  it("header row parses to exactly 7 fields via the RFC 4180-aware parser", () => {
    // If a column name ever changes to include a comma the header must be
    // quoted so parsers see 7 fields — not more.  This test uses the same
    // RFC 4180-aware parser as the data-field tests so it will fail if the
    // header is not properly quoted after such a rename.
    const csv = buildTempVcCsv([]);
    const [headerLine] = csv.split("\n");
    const fields = parseCsvRow(headerLine!);
    expect(fields).toHaveLength(7);
  });

  // ── empty input ─────────────────────────────────────────────────────────────

  it("returns only the header row when the input array is empty", () => {
    const csv = buildTempVcCsv([]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("id,user_id,channel_id,joined_at,left_at,duration_seconds,opted_out");
  });

  // ── opted_out column values ────────────────────────────────────────────────

  it("writes \"true\" in the opted_out column when optedOut is true", () => {
    const csv = buildTempVcCsv([makeRow({ optedOut: true })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.at(-1)).toBe("true");
  });

  it("writes \"false\" in the opted_out column when optedOut is false", () => {
    const csv = buildTempVcCsv([makeRow({ optedOut: false })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.at(-1)).toBe("false");
  });

  it("produces one opted-out row and one non-opted-out row when given both", () => {
    const csv = buildTempVcCsv([
      makeRow({ userId: "opted-out-user", optedOut: true  }),
      makeRow({ userId: "active-user",    optedOut: false }),
    ]);
    const [, row1, row2] = parseCsv(csv);
    expect(row1?.at(-1)).toBe("true");
    expect(row2?.at(-1)).toBe("false");
  });

  it("renders two rows for the same userId with different optedOut values independently", () => {
    // Guard against a CSV-builder bug that de-duplicates or collapses rows by
    // userId.  Both rows must appear with their distinct opted_out cell values.
    const joinedAt = new Date("2025-03-01T10:00:00.000Z");
    const leftAt1  = new Date("2025-03-01T11:00:00.000Z");
    const leftAt2  = new Date("2025-04-01T11:00:00.000Z");
    const csv = buildTempVcCsv([
      makeRow({ id: 1, userId: "same-user", joinedAt, leftAt: leftAt1, optedOut: false }),
      makeRow({ id: 2, userId: "same-user", joinedAt, leftAt: leftAt2, optedOut: true  }),
    ]);
    const lines = csv.split("\n");
    // Header + 2 data rows — no row dropped.
    expect(lines).toHaveLength(3);
    const [, dataRow1, dataRow2] = lines;
    expect(dataRow1?.at(-1)).toBe("e"); // last char of "false"
    expect(dataRow2?.at(-1)).toBe("e"); // last char of "true"
    // Full cell values via split.
    expect(dataRow1?.split(",").at(-1)).toBe("false");
    expect(dataRow2?.split(",").at(-1)).toBe("true");
  });

  it("CSV opted_out column reflects the per-row flag when the same userId has mixed values", () => {
    // Same userId with three sessions: false → true → false.
    // Each row must preserve its own flag; none must be homogenised.
    const base = new Date("2025-01-01T00:00:00.000Z");
    const rows = [
      makeRow({ id: 10, userId: "user-x", leftAt: new Date(base.getTime() + 1_000), optedOut: false }),
      makeRow({ id: 11, userId: "user-x", leftAt: new Date(base.getTime() + 2_000), optedOut: true  }),
      makeRow({ id: 12, userId: "user-x", leftAt: new Date(base.getTime() + 3_000), optedOut: false }),
    ];
    const csv = buildTempVcCsv(rows);
    const [, r1, r2, r3] = csv.split("\n");
    expect(r1?.split(",").at(-1)).toBe("false");
    expect(r2?.split(",").at(-1)).toBe("true");
    expect(r3?.split(",").at(-1)).toBe("false");
  });

  // ── other column values ────────────────────────────────────────────────────

  it("writes id in the first column", () => {
    const csv = buildTempVcCsv([makeRow({ id: 99 })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[0]).toBe("99");
  });

  it("writes user_id in the second column", () => {
    const csv = buildTempVcCsv([makeRow({ userId: "user-999" })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[1]).toBe("user-999");
  });

  it("writes channel_id in the third column", () => {
    const csv = buildTempVcCsv([makeRow({ channelId: "chan-999" })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[2]).toBe("chan-999");
  });

  it("writes joined_at as an ISO string in the fourth column", () => {
    const joinedAt = new Date("2025-04-10T08:00:00.000Z");
    const leftAt   = new Date("2025-04-10T08:05:00.000Z");
    const csv = buildTempVcCsv([makeRow({ joinedAt, leftAt })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[3]).toBe(joinedAt.toISOString());
  });

  it("writes left_at as an ISO string in the fifth column", () => {
    const joinedAt = new Date("2025-04-10T08:00:00.000Z");
    const leftAt   = new Date("2025-04-10T08:05:00.000Z");
    const csv = buildTempVcCsv([makeRow({ joinedAt, leftAt })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[4]).toBe(leftAt.toISOString());
  });

  it("writes duration_seconds as the floor of (leftAt - joinedAt) / 1000", () => {
    const joinedAt = new Date("2025-04-10T08:00:00.000Z");
    const leftAt   = new Date("2025-04-10T08:01:30.500Z"); // 90.5 s → floor → 90
    const csv = buildTempVcCsv([makeRow({ joinedAt, leftAt })]);
    const [, dataRow] = parseCsv(csv);
    expect(dataRow?.[5]).toBe("90");
  });

  // ── multi-row output ───────────────────────────────────────────────────────

  it("produces header + one line per row", () => {
    const rows = [makeRow(), makeRow({ id: 2 }), makeRow({ id: 3 })];
    const csv = buildTempVcCsv(rows);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4); // 1 header + 3 data rows
  });

  it("rows are joined with newlines (no trailing newline)", () => {
    const csv = buildTempVcCsv([makeRow()]);
    expect(csv.endsWith("\n")).toBe(false);
  });

  // ── comma in field values ──────────────────────────────────────────────────

  it("opted_out is still in column position 7 when channelId contains a comma", () => {
    // channelId with an embedded comma would shift all subsequent columns if
    // the field is not quoted, causing opted_out to land in the wrong position.
    const row = makeRow({ channelId: "chan,with,commas", optedOut: true });
    const csv = buildTempVcCsv([row]);
    const [, dataLine] = csv.split("\n");
    // Use the RFC 4180-aware parser so the quoted field is treated as one unit.
    const fields = parseCsvRow(dataLine!);
    // There must be exactly 7 fields: id, user_id, channel_id, joined_at,
    // left_at, duration_seconds, opted_out.
    expect(fields).toHaveLength(7);
    // The channel_id field (index 2) must equal the original value verbatim.
    expect(fields[2]).toBe("chan,with,commas");
    // opted_out must still be the last field and must be "true".
    expect(fields[6]).toBe("true");
  });

  it("opted_out is still in column position 7 when userId contains a comma", () => {
    const row = makeRow({ userId: "user,one", optedOut: false });
    const csv = buildTempVcCsv([row]);
    const [, dataLine] = csv.split("\n");
    const fields = parseCsvRow(dataLine!);
    expect(fields).toHaveLength(7);
    expect(fields[1]).toBe("user,one");
    expect(fields[6]).toBe("false");
  });

  it("double-quotes inside a field are escaped so the CSV remains parseable", () => {
    const row = makeRow({ channelId: 'chan"quoted"' });
    const csv = buildTempVcCsv([row]);
    const [, dataLine] = csv.split("\n");
    const fields = parseCsvRow(dataLine!);
    expect(fields).toHaveLength(7);
    expect(fields[2]).toBe('chan"quoted"');
  });
});
