#!/usr/bin/env sh
# Launch Pulsewire from any directory without remembering the Deno flags.
set -eu
cd "$(dirname "$0")"
exec deno task start "$@"
