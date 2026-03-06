#!/bin/sh
set -eu

PID_FILE=".run/bot.pid"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

if [ ! -f "$PROJECT_DIR/$PID_FILE" ]; then
  echo "Bot is not running"
  exit 0
fi

PID="$(cat "$PROJECT_DIR/$PID_FILE")"

if kill -0 "$PID" 2>/dev/null; then
  echo "Bot is running (pid $PID)"
else
  echo "Bot is not running, stale pid file exists"
  exit 1
fi
