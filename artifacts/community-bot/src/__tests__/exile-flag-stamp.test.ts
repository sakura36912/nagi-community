/**
 * Tests that resolveIsExile — the production helper used by the VoiceStateUpdate
 * handler in index.ts — stamps the isExile flag correctly for every input case.
 *
 * The function is extracted from the VoiceStateUpdate handler so it can be
 * imported and pinned here.  Any change to the exile-detection logic in
 * index.ts must also update resolveIsExile (src/lib/vc-exile.ts), which means
 * these tests will break if the production behaviour changes — giving us the
 * regression guarantee the task requires.
 *
 * Covers:
 *   1. Member with 追放者 role               → true
 *   2. Member without 追放者 (unrelated role) → false
 *   3. Member with no roles at all            → false
 *   4. member is null                         → false (safe fallback)
 *   5. member is undefined                    → false (safe fallback)
 *   6. Member has 追放者 alongside other roles → true
 */

import { describe, it, expect } from "vitest";
import { resolveIsExile } from "../lib/vc-exile.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build an ExileCheckMember from an array of role names. */
function makeMember(roleNames: string[]) {
  const roles = roleNames.map((name) => ({ name }));
  return {
    roles: {
      cache: {
        some(predicate: (role: { name: string }) => boolean): boolean {
          return roles.some(predicate);
        },
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveIsExile – exile flag stamping for VoiceStateUpdate handler", () => {
  // ── Case 1: member has 追放者 role ─────────────────────────────────────────

  it("returns true when the member holds the 追放者 role", () => {
    expect(resolveIsExile(makeMember(["追放者"]))).toBe(true);
  });

  // ── Case 2: member has a different role, not 追放者 ────────────────────────

  it("returns false when the member holds only unrelated roles (e.g. 島民)", () => {
    expect(resolveIsExile(makeMember(["島民"]))).toBe(false);
  });

  // ── Case 3: member has no roles ────────────────────────────────────────────

  it("returns false when the member has no roles at all", () => {
    expect(resolveIsExile(makeMember([]))).toBe(false);
  });

  // ── Case 4: member is null ─────────────────────────────────────────────────

  it("returns false (safe fallback) when member is null", () => {
    expect(resolveIsExile(null)).toBe(false);
  });

  // ── Case 5: member is undefined ───────────────────────────────────────────

  it("returns false (safe fallback) when member is undefined", () => {
    expect(resolveIsExile(undefined)).toBe(false);
  });

  // ── Case 6: member has 追放者 among multiple roles ─────────────────────────

  it("returns true when 追放者 is present alongside other roles", () => {
    expect(resolveIsExile(makeMember(["島民", "追放者", "守門卿"]))).toBe(true);
  });

  // ── Exact-name matching ────────────────────────────────────────────────────

  it("returns false for a role name that only partially matches 追放者", () => {
    // Ensures the check is exact string equality, not substring
    expect(resolveIsExile(makeMember(["追放"]))).toBe(false);
    expect(resolveIsExile(makeMember(["追放者X"]))).toBe(false);
  });
});
