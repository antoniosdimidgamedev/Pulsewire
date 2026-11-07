#!/usr/bin/env bash
# pulsewire-server.sh — Start the Pulsewire server automatically.
#
# Usage:
#   ./scripts/pulsewire-server.sh              # start in the foreground
#   ./scripts/pulsewire-server.sh --daemon     # start in the background (nohup)
#
# Environment variables (all optional):
#   PULSEWIRE_SERVER_HOST   Bind address (default: 127.0.0.1)
#   PULSEWIRE_SERVER_PORT   TCP port (default: 8787)
#   PULSEWIRE_SERVER_DB     SQLite database path (default: ./pulsewire.db)
#   PULSEWIRE_DB_KEY        At-rest encryption passphrase for message bodies
#   PULSEWIRE_SESSION_TTL_DAYS  Session cookie lifetime in days (default: 30)
#   PULSEWIRE_PBKDF2_ITERATIONS  Password hashing iterations (default: 210000)
#   PULSEWIRE_ADMIN_HANDLE  Handle promoted to administrator at first start
#   PULSEWIRE_DATA_DIR      Directory for the database and logs (default: ~/.local/share/pulsewire)
#
# For a trusted LAN, bind to 0.0.0.0 and use HTTPS (via a reverse proxy) for
# anything beyond the LAN. Message bodies are encrypted at rest when
# PULSEWIRE_DB_KEY is set.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DENO="${DENO:-deno}"
DAEMON=false

if [[ "${1:-}" == "--daemon" || "${1:-}" == "-d" ]]; then
  DAEMON=true
fi

DATA_DIR="${PULSEWIRE_DATA_DIR:-$HOME/.local/share/pulsewire}"
mkdir -p "$DATA_DIR"

LOG_FILE="${PULSEWIRE_LOG_FILE:-$DATA_DIR/server.log}"
PID_FILE="${PULSEWIRE_PID_FILE:-$DATA_DIR/server.pid}"

export PULSEWIRE_SERVER_HOST="${PULSEWIRE_SERVER_HOST:-127.0.0.1}"
export PULSEWIRE_SERVER_PORT="${PULSEWIRE_SERVER_PORT:-8787}"
export PULSEWIRE_SERVER_DB="${PULSEWIRE_SERVER_DB:-$DATA_DIR/pulsewire.db}"
export PULSEWIRE_SESSION_TTL_DAYS="${PULSEWIRE_SESSION_TTL_DAYS:-30}"
export PULSEWIRE_PBKDF2_ITERATIONS="${PULSEWIRE_PBKDF2_ITERATIONS:-210000}"

if [[ -n "${PULSEWIRE_DB_KEY:-}" ]]; then
  export PULSEWIRE_DB_KEY
fi
if [[ -n "${PULSEWIRE_ADMIN_HANDLE:-}" ]]; then
  export PULSEWIRE_ADMIN_HANDLE
fi

if ! command -v "$DENO" >/dev/null 2>&1; then
  echo "Error: deno not found. Install Deno (https://deno.com/) or set DENO." >&2
  exit 1
fi

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_daemon() {
  if is_running; then
    echo "Pulsewire is already running (PID $(cat "$PID_FILE"))."
    return 0
  fi

  nohup "$DENO" task server >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  # Wait briefly for the server to bind its port.
  for i in $(seq 1 30); do
    if is_running; then
      echo "Pulsewire started (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
      return 0
    fi
    sleep 0.2
  done

  echo "Error: Pulsewire did not start. Check $LOG_FILE" >&2
  return 1
}

start_foreground() {
  if is_running; then
    echo "Pulsewire is already running (PID $(cat "$PID_FILE"))." >&2
    return 1
  fi

  echo "Starting Pulsewire on ${PULSEWIRE_SERVER_HOST}:${PULSEWIRE_SERVER_PORT}"
  echo "Database: ${PULSEWIRE_SERVER_DB}"
  echo "Logs: $LOG_FILE"
  echo "Press Ctrl+C to stop."
  exec "$DENO" task server
}

if $DAEMON; then
  start_daemon
else
  start_foreground
fi
