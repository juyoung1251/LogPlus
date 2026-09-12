#!/bin/bash

# 5173번 포트를 사용하는 프로세스 ID(PID)를 찾습니다.
PID=$(lsof -t -i:5173)

if [ -z "$PID" ]; then
    echo "현재 실행 중인 리액트 서버(5173 포트)가 없습니다."
else
    echo "리액트 서버(PID: $PID)를 종료합니다..."
    kill -9 $PID
    echo "종료 완료!"
fi
