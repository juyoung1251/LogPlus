#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_LOG_ROOT="${APP_LOG_ROOT:-/app/logs}"
WEB_PORT=5174

if [ -d "/app/logplus/runtime/node-v22.23.1-linux-x64/bin" ]; then
    export PATH="/app/logplus/runtime/node-v22.23.1-linux-x64/bin:$PATH"
fi

mkdir -p "$APP_LOG_ROOT/web"
cd "$SCRIPT_DIR" || exit 1
nohup npm run dev -- --host 0.0.0.0 --port "$WEB_PORT" --strictPort >> "$APP_LOG_ROOT/web/dev.log" 2>&1 &
PID=$!

sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
    echo "서비스 시작 실패 (포트: $WEB_PORT, 로그: $APP_LOG_ROOT/web/dev.log)"
    exit 1
fi

echo "$PID" > "$SCRIPT_DIR/app.pid"
echo "서비스 실행 (PID: $PID, 포트: $WEB_PORT, 로그: $APP_LOG_ROOT/web/dev.log)"
