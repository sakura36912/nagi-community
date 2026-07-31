#!/bin/bash
# Regression guard: confirms that `pnpm run typecheck` exits non-zero when a
# type error is introduced into a shared library.  Run this on every merge to
# make sure the typecheck script never silently drops the lib filter.
set -euo pipefail

TARGET="lib/api-zod/src/index.ts"
BACKUP="${TARGET}.bak"
INJECTED_MARKER="DELIBERATE TYPE ERROR — injected by test-typecheck-catches-errors.sh"

cleanup() {
  if [ -f "$BACKUP" ]; then
    mv "$BACKUP" "$TARGET"
    echo "[typecheck-guard] Restored $TARGET"
  fi
}
trap cleanup EXIT

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

# ── Step 2: Inject a deliberate type error into the shared lib ─────────────
cp "$TARGET" "$BACKUP"
printf '\n// %s\nconst _badType: string = 42;\n' "$INJECTED_MARKER" >> "$TARGET"
echo "[typecheck-guard] Type error injected into $TARGET"

# ── Step 3: Typecheck must exit non-zero AND report the injected diagnostic ─
set +e
MUTANT_OUT=$(pnpm run typecheck 2>&1)
MUTANT_EXIT=$?
set -e

echo "$MUTANT_OUT"

if [ "$MUTANT_EXIT" -eq 0 ]; then
  echo "[typecheck-guard] FAIL: typecheck passed despite a type error in $TARGET" >&2
  echo "[typecheck-guard] The typecheck script is not covering shared libs." >&2
  exit 1
fi

# Confirm the failure is specifically about our injected line, not some
# unrelated transient error introduced by the environment.
# tsc reports errors as "<file>(line,col): error TSxxxx: ..." so we check
# that the output references the target file we mutated.
if ! echo "$MUTANT_OUT" | grep -qF "$TARGET"; then
  echo "[typecheck-guard] FAIL: typecheck exited $MUTANT_EXIT but the output does not reference '$TARGET'." >&2
  echo "[typecheck-guard] The failure may be unrelated to the injected error." >&2
  exit 1
fi

echo "[typecheck-guard] PASS: typecheck correctly exited $MUTANT_EXIT and reported the injected error in $TARGET"
