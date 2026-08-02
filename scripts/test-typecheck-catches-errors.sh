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

# ── Step 3: Probe each library ──────────────────────────────────────────────
probe_file "lib/api-zod/src/index.ts"
probe_file "lib/api-spec/orval.config.ts"
probe_file "lib/api-client-react/src/custom-fetch.ts"

echo "[typecheck-guard] All probes passed."
