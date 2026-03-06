#!/bin/sh
set -eu

RUN_DIR=".run"
PID_FILE="$RUN_DIR/bot.pid"
LOG_FILE="$RUN_DIR/bot.log"
PROJECT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

mkdir -p "$PROJECT_DIR/$RUN_DIR"

if [ -f "$PROJECT_DIR/$PID_FILE" ]; then
  PID="$(cat "$PROJECT_DIR/$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Bot already running (pid $PID)"
    exit 0
  fi
  rm -f "$PROJECT_DIR/$PID_FILE"
fi

(
  cd "$PROJECT_DIR"
  nohup /bin/sh -c 'exec node ./node_modules/tsx/dist/cli.mjs src/index.ts' >>"$LOG_FILE" 2>&1 </dev/null &
  echo "$!" >"$PID_FILE"
)
PID="$(cat "$PROJECT_DIR/$PID_FILE")"
echo "Bot started (pid $PID)"
echo "Log: $PROJECT_DIR/$LOG_FILE"
