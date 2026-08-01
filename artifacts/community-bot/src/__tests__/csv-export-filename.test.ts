/**
 * Unit tests for buildTempVcCsvFilename.
 *
 * The filename is built from an optional date range (start / end strings) and
 * an optional user ID.  These tests cover the four meaningful filter
 * combinations:
 *
 *   1. No filters         → tempvc-log-all.csv
 *   2. Date range only    → tempvc-log-YYYY-MM-DD_YYYY-MM-DD.csv
 *   3. User ID only       → tempvc-log-all-<userId>.csv
 *   4. Date range + user  → tempvc-log-YYYY-MM-DD_YYYY-MM-DD-<userId>.csv
 *
 * Plus edge-case variants for start-only and end-only date ranges.
 */

import { describe, it, expect } from "vitest";
import { buildTempVcCsvFilename } from "../commands/index.js";

describe("buildTempVcCsvFilename", () => {
  // ── no filters ──────────────────────────────────────────────────────────────

  it("returns tempvc-log-all.csv when no filters are supplied", () => {
    expect(buildTempVcCsvFilename({})).toBe("tempvc-log-all.csv");
  });

  it("returns tempvc-log-all.csv when all values are explicitly null", () => {
    expect(buildTempVcCsvFilename({ startStr: null, endStr: null, userId: null })).toBe(
      "tempvc-log-all.csv",
    );
  });

  // ── date range only ─────────────────────────────────────────────────────────

  it("includes both date strings joined with _ when start and end are provided", () => {
    expect(
      buildTempVcCsvFilename({ startStr: "2025-01-01", endStr: "2025-01-31" }),
    ).toBe("tempvc-log-2025-01-01_2025-01-31.csv");
  });

  it("uses from- prefix when only start is provided", () => {
    expect(buildTempVcCsvFilename({ startStr: "2025-06-01" })).toBe(
      "tempvc-log-from-2025-06-01.csv",
    );
  });

  it("uses until- prefix when only end is provided", () => {
    expect(buildTempVcCsvFilename({ endStr: "2025-06-30" })).toBe(
      "tempvc-log-until-2025-06-30.csv",
    );
  });

  // ── user ID only ─────────────────────────────────────────────────────────────

  it("appends -<userId> after 'all' when only user is provided", () => {
    expect(buildTempVcCsvFilename({ userId: "123456789" })).toBe(
      "tempvc-log-all-123456789.csv",
    );
  });

  // ── date range + user ────────────────────────────────────────────────────────

  it("combines both date strings and userId in the filename", () => {
    expect(
      buildTempVcCsvFilename({
        startStr: "2025-03-01",
        endStr: "2025-03-31",
        userId: "987654321",
      }),
    ).toBe("tempvc-log-2025-03-01_2025-03-31-987654321.csv");
  });

  it("combines from- prefix with userId when start-only and user are provided", () => {
    expect(
      buildTempVcCsvFilename({ startStr: "2025-09-01", userId: "111222333" }),
    ).toBe("tempvc-log-from-2025-09-01-111222333.csv");
  });

  it("combines until- prefix with userId when end-only and user are provided", () => {
    expect(
      buildTempVcCsvFilename({ endStr: "2025-09-30", userId: "444555666" }),
    ).toBe("tempvc-log-until-2025-09-30-444555666.csv");
  });
});
