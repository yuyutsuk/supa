#!/usr/bin/env bash
set -euo pipefail

# Better Auth migration runner
# Status: already run
# Last run: 2026-09-17 22:45:55Z
# Notes:
# - Applies drizzle SQL files in ascending filename order.
# - Runs against the linked Supabase project.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".local/.vars.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".local/.vars.env"
  set +a
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "Error: supabase CLI not found in PATH." >&2
  exit 1
fi

shopt -s nullglob
migration_files=(drizzle/[0-9][0-9][0-9][0-9]_*.sql)
shopt -u nullglob

if [[ ${#migration_files[@]} -eq 0 ]]; then
  echo "No migration files found in drizzle/."
  exit 1
fi

IFS=$'\n' migration_files=($(printf '%s\n' "${migration_files[@]}" | sort))
unset IFS

echo "Applying ${#migration_files[@]} migrations to linked Supabase project..."
for file in "${migration_files[@]}"; do
  echo "-> $file"
  supabase db query --linked --file "$file" --output json
done

echo "All migrations applied."
