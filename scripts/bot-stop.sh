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
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
  echo "Bot stopped (pid $PID)"
else
  echo "Bot process not found, cleaning stale pid file"
fi

rm -f "$PROJECT_DIR/$PID_FILE"
