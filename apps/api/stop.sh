#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/app.pid"

if [ ! -s "$PID_FILE" ]; then
    echo "관리 중인 API PID 파일이 없습니다. 다른 사용자의 프로세스는 종료하지 않습니다."
    exit 0
fi

PID="$(cat "$PID_FILE")"
if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
    echo "잘못된 PID 파일입니다: $PID" >&2
    exit 1
fi

if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "API 프로세스가 이미 종료되어 PID 파일만 정리했습니다."
    exit 0
fi

OWNER="$(ps -o user= -p "$PID" 2>/dev/null | xargs)"
CURRENT_OWNER="$(id -un)"
if [ "$OWNER" != "$CURRENT_OWNER" ] && [ "$CURRENT_OWNER" != "root" ]; then
    echo "PID $PID는 $OWNER 소유라 종료할 수 없습니다." >&2
    exit 1
fi

kill -TERM "$PID"
for _ in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
    echo "API가 정상 종료되지 않았습니다 (PID: $PID)." >&2
    exit 1
fi

rm -f "$PID_FILE"
echo "서버 종료됨 (PID: $PID)"
