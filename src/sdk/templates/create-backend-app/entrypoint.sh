#!/usr/bin/env sh
set -eu

{{migrateHookBegin}}
{{migrateHookEnd}}

exec "$@"
