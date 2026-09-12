#!/bin/bash

export PATH="/app/logplus/runtime/node-v22.23.1-linux-x64/bin:$PATH"
cd /app/logplus/ReactProject
nohup npm run dev -- --host 0.0.0.0 > dev.log 2>&1 &
echo "서비스 실행"
