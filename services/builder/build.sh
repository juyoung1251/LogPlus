#!/bin/bash

# =============================================
# LogPlus 자동 빌드 및 실행 스크립트 (멀티 언어 + Docker)
# 지원 언어: Python / Node.js / Java (Maven, Gradle) / C / C++
#
# 사용법: bash build.sh <user_id> <team_id> <username>
# 예시:   bash build.sh test1 test_project test1
# =============================================

# ── 인자 수신 ──
USERS_ID=$1
TEAM_ID=$2
USERNAME=$3

# post-receive가 넘기는 bare-repo Git 환경이 작업본 명령에 영향을 주지 않게 한다.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

# ── 인자 검증 ──
if [ -z "$USERS_ID" ] || [ -z "$TEAM_ID" ] || [ -z "$USERNAME" ]; then
    exit 1
fi

# ── 내부 bare repo 경로 ──
BARE_REPO="/repos/${TEAM_ID}/${USERS_ID}.git"

# ── 전체 빌드 로그 (모든 단계 기록) ──
BUILDER_LOG=/app/logplus/builder/builder.log
mkdir -p /app/logplus/builder

# ── 경로 설정 ──
PROJECT_DIR=/app/logplus/projects/$TEAM_ID/$USERS_ID
LOG_DIR=/app/logplus/logs/$TEAM_ID/$USERS_ID
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
RUN_LOG=$LOG_DIR/${TIMESTAMP}_RUN.log
LIB_INSTALL_LOG=$LOG_DIR/${TIMESTAMP}_LIB.log

# ── FastAPI 전송 주소 ──
FASTAPI_URL="http://localhost:8000/logs"

# ── 로그 저장 폴더 생성 ──
mkdir -p $LOG_DIR

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [START] users_id=$USERS_ID, team_id=$TEAM_ID, username=$USERNAME" >> $BUILDER_LOG

# =============================================
# 1. 레포지토리 clone or pull
# =============================================
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 1] 레포지토리 동기화 시작" >> $BUILDER_LOG

if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 1] 폴더 없음 → bare repo clone 실행" >> $BUILDER_LOG
    if ! git clone "$BARE_REPO" "$PROJECT_DIR" >> "$LIB_INSTALL_LOG" 2>&1; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] clone 실패" >> "$BUILDER_LOG"
        exit 1
    fi
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 1] 폴더 있음 → origin 강제 동기화" >> "$BUILDER_LOG"
    if ! git -C "$PROJECT_DIR" fetch origin >> "$LIB_INSTALL_LOG" 2>&1 ||
       ! git -C "$PROJECT_DIR" reset --hard origin/master >> "$LIB_INSTALL_LOG" 2>&1 ||
       ! git -C "$PROJECT_DIR" clean -fd >> "$LIB_INSTALL_LOG" 2>&1; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] 작업본 동기화 실패" >> "$BUILDER_LOG"
        exit 1
    fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 1] 레포지토리 동기화 완료" >> $BUILDER_LOG

# =============================================
# 2. Dockerfile 존재 여부 확인
# =============================================
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 확인 시작" >> $BUILDER_LOG

BUILD_STATUS=0
RUN_STATUS=0
DOCKER_IMAGE="${USERNAME}-${TEAM_ID}"

if [ -f "$PROJECT_DIR/Dockerfile" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 감지 — 해당 파일로 빌드 진행" >> $BUILDER_LOG
    echo "Dockerfile 감지 — 해당 파일로 빌드 진행" >> $LIB_INSTALL_LOG

else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 없음 — 언어 자동 감지 시작" >> $BUILDER_LOG
    echo "Dockerfile 없음 — 언어 자동 감지 시작" >> $LIB_INSTALL_LOG

    LANG_TYPE="unknown"

    if [ -f "$PROJECT_DIR/requirements.txt" ] || find "$PROJECT_DIR" -maxdepth 1 -name "*.py" | grep -q .; then
        LANG_TYPE="python"
    elif [ -f "$PROJECT_DIR/package.json" ]; then
        LANG_TYPE="nodejs"
    elif [ -f "$PROJECT_DIR/pom.xml" ]; then
        LANG_TYPE="java-maven"
    elif [ -f "$PROJECT_DIR/build.gradle" ]; then
        LANG_TYPE="java-gradle"
    elif [ -f "$PROJECT_DIR/CMakeLists.txt" ] || find "$PROJECT_DIR" -maxdepth 1 -name "*.cpp" | grep -q .; then
        LANG_TYPE="cpp"
    elif [ -f "$PROJECT_DIR/Makefile" ] || find "$PROJECT_DIR" -maxdepth 1 -name "*.c" | grep -q .; then
        LANG_TYPE="c"
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] 감지된 언어: $LANG_TYPE" >> $BUILDER_LOG
    echo "감지된 언어: $LANG_TYPE" >> $LIB_INSTALL_LOG

    case $LANG_TYPE in

      python)
        if [ ! -f "$PROJECT_DIR/requirements.txt" ]; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] requirements.txt 없음 — import 분석으로 자동 생성" >> $BUILDER_LOG
            echo "requirements.txt 없음 — import 분석으로 자동 생성 시도" >> $LIB_INSTALL_LOG
            grep -hE "^import |^from " $PROJECT_DIR/*.py 2>/dev/null | \
            awk '{print $2}' | cut -d'.' -f1 | sort -u | \
            grep -vE "^(os|sys|re|json|math|time|datetime|pathlib|typing|collections|itertools|functools|abc|io|copy|enum|logging|unittest|subprocess|threading|socket|hashlib|base64|random|string|struct|csv|xml|html|http|urllib|email|uuid|traceback|warnings|inspect|gc|weakref|contextlib|dataclasses|shutil|glob|fnmatch|tempfile|platform|signal|ctypes|array|queue|heapq|bisect|decimal|fractions|statistics|argparse|configparser|pickle|shelve|sqlite3|zipfile|tarfile|gzip|bz2|lzma|zlib)$" \
            > $PROJECT_DIR/requirements.txt
            echo "requirements.txt 자동 생성 완료" >> $LIB_INSTALL_LOG
        fi

        MAIN_FILE="main.py"
        [ -f "$PROJECT_DIR/app.py" ] && MAIN_FILE="app.py"

        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM python:3.11
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
CMD ["python3", "$MAIN_FILE"]
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (Python)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (Python)" >> $LIB_INSTALL_LOG
        ;;

      nodejs)
        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
CMD ["npm", "start"]
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (Node.js)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (Node.js)" >> $LIB_INSTALL_LOG
        ;;

      java-maven)
        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM maven:3.9-eclipse-temurin-17
WORKDIR /app
COPY . .
RUN mvn install
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (Java-Maven)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (Java-Maven)" >> $LIB_INSTALL_LOG
        ;;

      java-gradle)
        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM gradle:8-jdk17
WORKDIR /app
COPY . .
RUN gradle build
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (Java-Gradle)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (Java-Gradle)" >> $LIB_INSTALL_LOG
        ;;

      cpp)
        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM gcc:latest
WORKDIR /app
COPY . .
RUN mkdir -p build && cmake -S . -B build && make -C build
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (C++)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (C++)" >> $LIB_INSTALL_LOG
        ;;

      c)
        cat > $PROJECT_DIR/Dockerfile <<EOF
FROM gcc:latest
WORKDIR /app
COPY . .
RUN gcc *.c -o output
EOF
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 2] Dockerfile 자동 생성 완료 (C)" >> $BUILDER_LOG
        echo "Dockerfile 자동 생성 완료 (C)" >> $LIB_INSTALL_LOG
        ;;

      unknown)
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] 언어 감지 실패 — 빌드 중단" >> $BUILDER_LOG
        echo "오류: 언어 감지 실패 — Dockerfile, requirements.txt, package.json, pom.xml 등 관련 파일이 존재하지 않습니다." >> $LIB_INSTALL_LOG

        curl -s -X POST $FASTAPI_URL \
        -H "Content-Type: application/json" \
        -d "{
          \"users_id\": \"$USERS_ID\",
          \"team_id\": \"$TEAM_ID\",
          \"log_type\": \"lib\",
          \"log_path\": \"$LIB_INSTALL_LOG\"
        }"
        exit 1
        ;;

    esac
fi

# =============================================
# 3. Docker 빌드 및 실행
# =============================================
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 3] Docker 빌드 시작 ($DOCKER_IMAGE)" >> $BUILDER_LOG
echo "--- Docker 빌드 시작 ---" >> $LIB_INSTALL_LOG
docker build -t $DOCKER_IMAGE $PROJECT_DIR >> $LIB_INSTALL_LOG 2>&1
BUILD_STATUS=$?

if [ $BUILD_STATUS -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 3] Docker 빌드 성공 — 실행 시작" >> $BUILDER_LOG
    echo "--- Docker 실행 시작 ---" >> $RUN_LOG
    docker run --rm $DOCKER_IMAGE >> $RUN_LOG 2>&1
    RUN_STATUS=$?
    docker rmi $DOCKER_IMAGE >> /dev/null 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 3] Docker 실행 종료 (status=$RUN_STATUS)" >> $BUILDER_LOG
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 3] Docker 빌드 실패 — 실행 건너뜀" >> $BUILDER_LOG
    echo "Docker 빌드 실패 — 실행 건너뜀" >> $RUN_LOG
fi

# =============================================
# 4. FastAPI로 전송 (lib / run 각각 저장)
# =============================================
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 4] FastAPI 전송 시작" >> $BUILDER_LOG

curl -s -X POST $FASTAPI_URL \
-H "Content-Type: application/json" \
-d "{
  \"users_id\": \"$USERS_ID\",
  \"team_id\": \"$TEAM_ID\",
  \"log_type\": \"lib\",
  \"log_path\": \"$LIB_INSTALL_LOG\"
}"

curl -s -X POST $FASTAPI_URL \
-H "Content-Type: application/json" \
-d "{
  \"users_id\": \"$USERS_ID\",
  \"team_id\": \"$TEAM_ID\",
  \"log_type\": \"run\",
  \"log_path\": \"$RUN_LOG\"
}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [STEP 4] FastAPI 전송 완료" >> $BUILDER_LOG
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [END] 빌드 종료" >> $BUILDER_LOG
