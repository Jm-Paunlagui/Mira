#!/usr/bin/env bash
# =============================================================================
# Package check: install the packed tarball into an empty project and use it the
# way an app would. No .env, no MIRA_* or 2.x variables: the app names its pool
# "shop" and passes credentials from its own PKG_DB_* variables.
#
#   PKG_DB_USER=… PKG_DB_PASSWORD=… PKG_DB_CONNECT_STRING=… test/package/run.sh
#   (with MIRA_DB_* set instead, they are copied to PKG_DB_* and then unset)
#
# Checks: strict tsc over the app and the published .d.ts files, a TypeScript
# app under Bun, a CommonJS and an ES-module app under Node, and the mira CLI.
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

export PKG_DB_USER="${PKG_DB_USER:-${MIRA_DB_USER:-}}"
export PKG_DB_PASSWORD="${PKG_DB_PASSWORD:-${MIRA_DB_PASSWORD:-}}"
export PKG_DB_CONNECT_STRING="${PKG_DB_CONNECT_STRING:-${MIRA_DB_CONNECT_STRING:-}}"
if [[ -z $PKG_DB_USER || -z $PKG_DB_PASSWORD || -z $PKG_DB_CONNECT_STRING ]]; then
  echo "package check: set PKG_DB_USER, PKG_DB_PASSWORD and PKG_DB_CONNECT_STRING (or MIRA_DB_*)." >&2
  exit 2
fi
# Nothing Mira 2.x or fromEnv() would read may leak in: the apps must work without it.
for v in $(compgen -e); do
  case $v in MIRA_*|APP_DB_*|APP_TEST_DB_*|APP_POOL_*|APP_BULK_*|DB_HOST|DB_PORT|DB_APP_SERVICE_NAME|DB_TYPE|ORACLE_INSTANT_CLIENT|ENABLE_CONSOLE_LOGS|LOG_*) unset "$v" ;; esac
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mira-pkg-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)  # prepack builds dist/
TGZ=$(ls "$WORK"/*.tgz)
APP="$WORK/app"
mkdir "$APP"
cp "$ROOT"/test/package/{app.ts,app.cjs,app.mjs,tsconfig.json} "$APP"
cd "$APP"
npm init -y >/dev/null
# The path goes in as an argument, not inside the script text: Git Bash converts
# /d/... to D:/... for arguments only, and Node on Windows cannot resolve /d/....
TYPES_NODE=$(node -p "require(process.argv[1]).devDependencies['@types/node']" "$ROOT/package.json")
npm install --silent --no-audit --no-fund "$TGZ" "@types/node@$TYPES_NODE" >/dev/null
echo "package check: installed $(basename "$TGZ") into an empty project"

node "$ROOT/node_modules/typescript/bin/tsc" -p .
echo "package check OK: strict tsc (app + published .d.ts)"
bun app.ts
node app.cjs
node app.mjs
./node_modules/.bin/mira --help | grep -q "^Usage:"
echo "package check OK: mira CLI"
[[ ! -e logs ]] || { echo "package check failed: a logs folder was written" >&2; exit 1; }
