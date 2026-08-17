#!/bin/bash
# Regression guard: confirms that `pnpm run typecheck` exits non-zero when a
# type error is introduced into each shared library covered by the typecheck
# script.  Run this on every merge to make sure the typecheck script never
# silently drops any of the lib filters.
set -euo pipefail

INJECTED_MARKER="DELIBERATE TYPE ERROR — injected by test-typecheck-catches-errors.sh"

# ── Step 1: Baseline must be clean ─────────────────────────────────────────
echo "[typecheck-guard] Running baseline typecheck (must pass)..."
set +e
BASELINE_OUT=$(pnpm run typecheck 2>&1)
BASELINE_EXIT=$?
set -e

if [ "$BASELINE_EXIT" -ne 0 ]; then
  echo "[typecheck-guard] FAIL: baseline typecheck already exits $BASELINE_EXIT — pre-existing error or broken environment." >&2
  echo "$BASELINE_OUT" >&2
  exit 1
fi
echo "[typecheck-guard] Baseline clean."

# ── Step 2: probe_file <target> ─────────────────────────────────────────────
# Injects a deliberate type error, verifies typecheck exits non-zero and
# references the mutated file, then restores the original.
probe_file() {
  local TARGET="$1"
  local BACKUP="${TARGET}.bak"

  if [ ! -f "$TARGET" ]; then
    echo "[typecheck-guard] FAIL: probe target not found: $TARGET" >&2
    echo "[typecheck-guard] Rename or deletion of this file must be reflected in this guard script." >&2
    exit 1
  fi

  cleanup_probe() {
    if [ -f "$BACKUP" ]; then
      mv "$BACKUP" "$TARGET"
      echo "[typecheck-guard] Restored $TARGET"
    fi
  }
  trap cleanup_probe EXIT

  cp "$TARGET" "$BACKUP"
  printf '\n// %s\nconst _badType: string = 42;\n' "$INJECTED_MARKER" >> "$TARGET"
  echo "[typecheck-guard] Type error injected into $TARGET"

  set +e
  MUTANT_OUT=$(pnpm run typecheck 2>&1)
  MUTANT_EXIT=$?
  set -e

  echo "$MUTANT_OUT"

  if [ "$MUTANT_EXIT" -eq 0 ]; then
    echo "[typecheck-guard] FAIL: typecheck passed despite a type error in $TARGET" >&2
    echo "[typecheck-guard] The typecheck script is not covering this lib." >&2
    exit 1
  fi

  # tsc reports paths relative to the package when run via `pnpm -r`, so the
  # output may contain just the basename rather than the full workspace path.
  local BASENAME
  BASENAME=$(basename "$TARGET")
  if ! echo "$MUTANT_OUT" | grep -qF "$BASENAME"; then
    echo "[typecheck-guard] FAIL: typecheck exited $MUTANT_EXIT but the output does not reference '$BASENAME'." >&2
    echo "[typecheck-guard] The failure may be unrelated to the injected error." >&2
    exit 1
  fi

  # Restore immediately so subsequent probes start from a clean baseline.
  mv "$BACKUP" "$TARGET"
  trap - EXIT
  echo "[typecheck-guard] Restored $TARGET"
  echo "[typecheck-guard] PASS ($TARGET): typecheck correctly exited $MUTANT_EXIT and reported the injected error."
}

# ── Step 2b: Self-test — probe_file must reject a non-existent target ────────
# This ensures the existence-check exit path itself cannot be silently broken
# by a future refactor.  Run in a subshell so exit 1 does not abort the guard.
echo "[typecheck-guard] Self-test: probe_file with a non-existent path must exit 1 and say 'probe target not found'..."
set +e
SELFTEST_OUT=$(probe_file "/tmp/__nonexistent_probe_target_guard_selftest" 2>&1)
SELFTEST_EXIT=$?
set -e

if [ "$SELFTEST_EXIT" -ne 1 ]; then
  echo "[typecheck-guard] FAIL: self-test expected probe_file to exit 1 for a missing target, but got exit $SELFTEST_EXIT" >&2
  exit 1
fi
if ! echo "$SELFTEST_OUT" | grep -qF "probe target not found"; then
  echo "[typecheck-guard] FAIL: self-test did not find 'probe target not found' in probe_file output" >&2
  echo "$SELFTEST_OUT" >&2
  exit 1
fi
echo "[typecheck-guard] Self-test PASS: probe_file correctly rejected a non-existent target."

# ── Step 2c: Self-test — probe_file must catch a file outside all tsconfigs ──
# A file that EXISTS but is not covered by any tsconfig will be compiled by
# `tsc` only if that tsconfig's include/exclude globs reach it.  If not
# covered, the injected error is invisible and typecheck exits 0 — probe_file
# must detect that and exit 1 with "typecheck passed despite a type error".
echo "[typecheck-guard] Self-test: probe_file with an existing but uncovered file must exit 1 with 'typecheck passed despite a type error'..."
UNCOVERED_FILE="/tmp/__uncovered_probe_target_guard_selftest_$$.ts"
# Create the file so the existence check passes, then let probe_file inject the error.
echo "// uncovered file — not in any tsconfig" > "$UNCOVERED_FILE"
set +e
UNCOVERED_OUT=$(probe_file "$UNCOVERED_FILE" 2>&1)
UNCOVERED_EXIT=$?
set -e
# Always clean up even if probe_file left a backup alongside the original.
rm -f "$UNCOVERED_FILE" "${UNCOVERED_FILE}.bak"

if [ "$UNCOVERED_EXIT" -ne 1 ]; then
  echo "[typecheck-guard] FAIL: self-test expected probe_file to exit 1 for an uncovered file, but got exit $UNCOVERED_EXIT" >&2
  echo "$UNCOVERED_OUT" >&2
  exit 1
fi
if ! echo "$UNCOVERED_OUT" | grep -qF "typecheck passed despite a type error"; then
  echo "[typecheck-guard] FAIL: self-test did not find 'typecheck passed despite a type error' in probe_file output for uncovered file" >&2
  echo "$UNCOVERED_OUT" >&2
  exit 1
fi
echo "[typecheck-guard] Self-test PASS: probe_file correctly detected an uncovered-file blind spot."

# ── Step 3: Probe each library ──────────────────────────────────────────────
probe_file "lib/api-zod/src/index.ts"
probe_file "lib/api-spec/orval.config.ts"
probe_file "lib/api-client-react/src/custom-fetch.ts"

echo "[typecheck-guard] All probes passed."
