#!/usr/bin/env bash
set -euo pipefail

# Supervise all three services, not just the HTTP server. A dead bot must not
# leave a healthy-looking API process that prevents the VM from restarting.
exec node scripts/supervise-production.mjs
