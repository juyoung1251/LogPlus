import os
import re
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database import get_db, LogTable

router = APIRouter(prefix="/dashboard")

# 로그 뷰어(Index.tsx)의 줄 강조와 같은 규칙으로 레벨을 판별한다
LEVEL_RE = re.compile(r"\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b", re.IGNORECASE)
# 예외 선언 줄만 센다. 이름 뒤에 ':' 이나 줄 끝이 와야 하고, 패키지 경로(java.lang.)는 뗀다
#   ZeroDivisionError: division by zero / Caused by: java.net.ConnectException: ...
EXCEPTION_RE = re.compile(
    r"(?:^|[\s\[(])(?:[a-z_][\w$]*\.)*([A-Z][\w$]*(?:Exception|Error))(?::|\s*$)"
)
# 들여쓴 줄은 스택 프레임(Java "at ...")이나 트레이스백에 찍힌 소스 코드라
# 예외 이름이 들어 있어도 발생으로 치지 않는다
FRAME_RE = re.compile(r"^\s")
TIME_RE = re.compile(r"\b(\d{2}:\d{2}:\d{2})\b")
LEADING_TAG_RE = re.compile(r"^\s*\[?(ERROR|WARN(?:ING)?|INFO|DEBUG)\]?[:\s-]*", re.IGNORECASE)

# ── 언어 판별 ──
# 빌드 1건의 언어는 그 빌드의 LIB 로그에서 정한다. 작업 폴더는 push 할 때마다 덮어써져서
# 폴더로 판별하면 과거 빌드가 모두 "지금 폴더의 언어"로 집계된다(Python 빌드가 C/C++로 잡히던 원인).
#   1순위: build.sh 가 자동 감지 후 남긴 "감지된 언어: <type>" 줄
#   2순위: docker build 출력의 베이스 이미지 (load metadata for docker.io/library/python:3.12-slim, FROM gcc:13 ...)
#   3순위: LIB 로그가 없거나 단서가 없을 때만 현재 작업 폴더로 판별
BUILD_SH_LANG_RE = re.compile(r"감지된 언어:\s*([\w-]+)")
BUILD_SH_LANGS = {
    "python": "Python",
    "nodejs": "Node",
    "java-maven": "Java-Maven",
    "java-gradle": "Java-Gradle",
    "cpp": "C/C++",
    "c": "C/C++",
}
BASE_IMAGE_RE = re.compile(
    r"(?:load metadata for|\bFROM)\s+(?:--platform=\S+\s+)?(?:[\w.-]+(?::\d+)?/)*([a-z0-9][a-z0-9._-]*)",
    re.IGNORECASE,
)
BASE_IMAGES = {
    "python": "Python", "pypy": "Python",
    "node": "Node",
    "maven": "Java-Maven",
    "gradle": "Java-Gradle",
    "openjdk": "Java", "eclipse-temurin": "Java", "amazoncorretto": "Java",
    "gcc": "C/C++", "clang": "C/C++",
}

# 폴더 판별(3순위)용. 순서가 우선순위다. 소스가 하위 폴더(src/ 등)에 있어도 잡도록 2단계까지 본다.
PYTHON_MARKERS = ("requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile")
C_SOURCE_GLOBS = ("*.c", "*.cc", "*.cpp", "*.cxx")


def _has_files(d: Path, *patterns: str) -> bool:
    return any(
        next(d.glob(prefix + pattern), None) is not None
        for pattern in patterns
        for prefix in ("", "*/")
    )


LANGUAGE_RULES = [
    ("Python", lambda d: any((d / m).is_file() for m in PYTHON_MARKERS) or _has_files(d, "*.py")),
    ("Node", lambda d: (d / "package.json").is_file()),
    ("Java-Maven", lambda d: (d / "pom.xml").is_file()),
    ("Java-Gradle", lambda d: (d / "build.gradle").is_file() or (d / "build.gradle.kts").is_file()),
    # Makefile/CMakeLists.txt 만으로는 C/C++로 보지 않는다(Python 프로젝트도 Makefile 을 흔히 쓴다).
    # 실제 C/C++ 소스가 있어야 한다. 헤더(.h)만 있는 경우도 제외.
    ("C/C++", lambda d: _has_files(d, *C_SOURCE_GLOBS)),
]


def _run_logs(db: Session, users_id: str, team_id: str, since: Optional[datetime] = None):
    query = db.query(LogTable).filter(
        LogTable.users_id == users_id,
        LogTable.team_id == team_id,
        LogTable.log_type == "run",
    )
    if since is not None:
        query = query.filter(LogTable.created_at >= since)
    return query.order_by(LogTable.created_at.desc(), LogTable.build_log_id.desc())


def _read_lines(log_path: Optional[str]) -> List[str]:
    # 파일이 지워졌거나 읽을 수 없는 로그는 집계에서 빼고 넘어간다
    if not log_path or not os.path.isfile(log_path):
        return []
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except OSError as e:
        print(f"대시보드 로그 읽기 실패 (path={log_path}): {e}")
        return []


def _level(line: str) -> Optional[str]:
    match = LEVEL_RE.search(line)
    if not match:
        return None
    token = match.group(1).upper()
    return "WARN" if token == "WARNING" else token


def _detect_language(project_dir: Path) -> str:
    if not project_dir.is_dir():
        return "알 수 없음"
    for name, matches in LANGUAGE_RULES:
        if matches(project_dir):
            return name
    return "기타"


def _lib_log_path(run_log_path: Optional[str]) -> Optional[str]:
    # build.sh 는 같은 TIMESTAMP 로 <ts>_RUN.log / <ts>_LIB.log 를 함께 만든다
    if not run_log_path or not run_log_path.endswith("_RUN.log"):
        return None
    return run_log_path[: -len("_RUN.log")] + "_LIB.log"


def _language_from_lib_log(lib_log_path: Optional[str]) -> Optional[str]:
    """빌드 당시 기록된 LIB 로그에서 언어를 찾는다. 단서가 없으면 None."""
    if not lib_log_path or not os.path.isfile(lib_log_path):
        return None
    image_language = None
    try:
        with open(lib_log_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                match = BUILD_SH_LANG_RE.search(line)
                if match and match.group(1) in BUILD_SH_LANGS:
                    return BUILD_SH_LANGS[match.group(1)]
                if image_language is None:
                    for image in BASE_IMAGE_RE.findall(line):
                        if image.lower() in BASE_IMAGES:
                            image_language = BASE_IMAGES[image.lower()]
                            break
    except OSError as e:
        print(f"대시보드 LIB 로그 읽기 실패 (path={lib_log_path}): {e}")
    return image_language


@router.get("/daily-stats")
def daily_stats(
    users_id: str,
    team_id: str,
    days: int = Query(7, ge=1, le=90),
    db: Session = Depends(get_db),
):
    """최근 N일(오늘 포함) RUN 로그의 ERROR/WARN 줄 수를 빌드 날짜별로 센다."""
    today = date.today()
    first_day = today - timedelta(days=days - 1)
    counts = {
        (first_day + timedelta(days=i)).isoformat(): {"error": 0, "warn": 0}
        for i in range(days)
    }

    since = datetime.combine(first_day, datetime.min.time())
    for log in _run_logs(db, users_id, team_id, since):
        if not log.created_at:
            continue
        bucket = counts.get(log.created_at.date().isoformat())
        if bucket is None:
            continue
        for line in _read_lines(log.log_path):
            level = _level(line)
            if level == "ERROR":
                bucket["error"] += 1
            elif level == "WARN":
                bucket["warn"] += 1

    return {
        "status": "success",
        "days": [{"date": day, **values} for day, values in counts.items()],
    }


@router.get("/top-exceptions")
def top_exceptions(
    users_id: str,
    team_id: str,
    limit: int = Query(3, ge=1, le=20),
    db: Session = Depends(get_db),
):
    """전체 RUN 로그에서 예외 클래스명을 뽑아 많이 발생한 순으로 돌려준다."""
    counter = Counter()
    for log in _run_logs(db, users_id, team_id):
        for line in _read_lines(log.log_path):
            if FRAME_RE.match(line):
                continue
            match = EXCEPTION_RE.search(line)
            if match:
                counter[match.group(1)] += 1

    return {
        "status": "success",
        "exceptions": [
            {"name": name, "count": count} for name, count in counter.most_common(limit)
        ],
    }


@router.get("/language-distribution")
def language_distribution(team_id: str, db: Session = Depends(get_db)):
    """팀의 RUN 빌드 1건을 1표로 보고, 그 빌드의 LIB 로그(빌드 당시 기록)로 언어를 정한다.
    LIB 로그에 단서가 없을 때만 사용자 작업 폴더의 현재 상태로 판별한다."""
    project_root = Path(os.getenv("PROJECT_ROOT", "/app/logplus-platform/projects"))
    builds = (
        db.query(LogTable.users_id, LogTable.log_path)
        .filter(LogTable.team_id == team_id, LogTable.log_type == "run")
        .all()
    )

    folder_languages = {}
    counter = Counter()
    for users_id, log_path in builds:
        language = _language_from_lib_log(_lib_log_path(log_path))
        if language is None:
            if users_id not in folder_languages:
                folder_languages[users_id] = _detect_language(project_root / team_id / users_id)
            language = folder_languages[users_id]
        counter[language] += 1

    total = sum(counter.values())
    return {
        "status": "success",
        "total": total,
        "languages": [
            {"language": name, "count": count, "percent": round(count * 100 / total, 1)}
            for name, count in counter.most_common()
        ],
    }


@router.get("/recent-alerts")
def recent_alerts(
    users_id: str,
    team_id: str,
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """최근 RUN 로그에서 ERROR/WARN/INFO 줄을 최신순으로 limit개 뽑는다.
    로그 줄에 시각이 없으면 그 로그 파일이 저장된 시각을 쓴다."""
    alerts = []
    for log in _run_logs(db, users_id, team_id):
        logged_at = log.created_at or datetime.min
        # 한 파일 안에서는 아래 줄이 더 나중에 찍힌 것이다
        for line in reversed(_read_lines(log.log_path)):
            level = _level(line)
            if level not in ("ERROR", "WARN", "INFO"):
                continue
            time_match = TIME_RE.search(line)
            alerts.append({
                "build_log_id": log.build_log_id,
                "level": level,
                "message": LEADING_TAG_RE.sub("", line).strip() or line.strip(),
                "date": logged_at.date().isoformat(),
                "time": time_match.group(1) if time_match else logged_at.strftime("%H:%M:%S"),
            })
            if len(alerts) >= limit:
                return {"status": "success", "alerts": alerts}

    return {"status": "success", "alerts": alerts}
