#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/logplus-colab.env"

if [ ! -r "$ENV_FILE" ]; then
    echo "설정 파일을 읽을 수 없습니다: $ENV_FILE" >&2
    exit 1
fi

set -a
source "$ENV_FILE" || exit 1
set +a

: "${OLLAMA_URL:?OLLAMA_URL 설정이 필요합니다}"
: "${OLLAMA_API_KEY:?OLLAMA_API_KEY 설정이 필요합니다}"

APP_LOG_ROOT="${APP_LOG_ROOT:-/app/logs}"
USER_LOG_ROOT="${USER_LOG_ROOT:-/app/logplus-platform/logs}"
PID_FILE="$SCRIPT_DIR/app.pid"
export APP_LOG_ROOT USER_LOG_ROOT
export PYTHONUNBUFFERED=1

mkdir -p "$APP_LOG_ROOT/api"
cd "$SCRIPT_DIR" || exit 1

if [ -s "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE")"
    if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        OLD_OWNER="$(ps -o user= -p "$OLD_PID" 2>/dev/null | xargs)"
        CURRENT_OWNER="$(id -un)"
        if [ "$OLD_OWNER" != "$CURRENT_OWNER" ] && [ "$CURRENT_OWNER" != "root" ]; then
            echo "기존 API PID $OLD_PID는 $OLD_OWNER 소유라 종료할 수 없습니다." >&2
            exit 1
        fi
        kill -TERM "$OLD_PID" 2>/dev/null || true
        sleep 1
    fi
fi

if command -v lsof >/dev/null 2>&1; then
    PORT_PID="$(lsof -t -iTCP:8000 -sTCP:LISTEN 2>/dev/null | head -n 1)"
    if [ -n "$PORT_PID" ]; then
        PORT_OWNER="$(ps -o user= -p "$PORT_PID" 2>/dev/null | xargs)"
        echo "8000 포트가 이미 사용 중입니다 (PID: $PORT_PID, 사용자: ${PORT_OWNER:-확인 불가})." >&2
        echo "해당 프로세스의 소유자로 종료한 뒤 다시 실행하세요." >&2
        exit 1
    fi
fi

nohup uvicorn main:app --host 0.0.0.0 --port 8000 --reload >> "$APP_LOG_ROOT/api/app.log" 2>&1 &
echo $! > "$PID_FILE"
echo "서버 시작됨 (PID: $!, 로그: $APP_LOG_ROOT/api/app.log)"
