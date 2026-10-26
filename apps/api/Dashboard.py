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

# services/builder/build.sh 의 언어 감지와 같은 순서·조건
LANGUAGE_RULES = [
    ("Python", lambda d: (d / "requirements.txt").is_file() or any(d.glob("*.py"))),
    ("Node", lambda d: (d / "package.json").is_file()),
    ("Java-Maven", lambda d: (d / "pom.xml").is_file()),
    ("Java-Gradle", lambda d: (d / "build.gradle").is_file()),
    ("C/C++", lambda d: (d / "CMakeLists.txt").is_file() or (d / "Makefile").is_file()
        or any(d.glob("*.cpp")) or any(d.glob("*.c"))),
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
    """팀의 RUN 빌드 1건을 1표로 보고, 빌드한 사용자 작업 폴더의 설정 파일로 언어를 정한다.
    폴더의 현재 상태로 판별하므로 과거 빌드도 지금 폴더의 언어로 집계된다."""
    project_root = Path(os.getenv("PROJECT_ROOT", "/app/logplus-platform/projects"))
    builds = (
        db.query(LogTable.users_id)
        .filter(LogTable.team_id == team_id, LogTable.log_type == "run")
        .all()
    )

    languages = {}
    counter = Counter()
    for (users_id,) in builds:
        if users_id not in languages:
            languages[users_id] = _detect_language(project_root / team_id / users_id)
        counter[languages[users_id]] += 1

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
