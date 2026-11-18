#!/bin/sh
installation_root=$(dirname -- "$(readlink -f -- "$0")") || exit 1
exec "$installation_root/runtime/bun" --no-install "$installation_root/app/launch.mjs" "$@"
