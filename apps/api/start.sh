#!/bin/bash
pkill -f "uvicorn main:app" 2>/dev/null
sleep 1
nohup uvicorn main:app --host 0.0.0.0 --port 8000 --reload > app.log 2>&1 &
echo $! > app.pid
echo "서버 시작됨 (PID: $!)"
