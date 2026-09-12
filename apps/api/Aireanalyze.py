import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db, LogTable, AiAnalysisTable

router = APIRouter()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/v1/chat/completions")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
MAX_LOG_CHARS = 12000

# 분석 결과 txt가 쌓이는 곳: /app/logplus/logs/{team_id}/{users_id}/analyses/
LOG_ROOT = Path(os.getenv("LOG_ROOT", "/app/logplus/logs")).resolve()
ANALYSIS_DIRNAME = "analyses"
# 로그 1건당 보관할 분석 이력 개수. 0이면 무제한(아무것도 지우지 않음).
ANALYSIS_KEEP_PER_LOG = int(os.getenv("ANALYSIS_KEEP_PER_LOG", "0"))


class ReanalyzeInput(BaseModel):
    users_id: str
    team_id: str
    build_log_id: int


class HistoryInput(BaseModel):
    users_id: str
    team_id: str
    build_log_id: Optional[int] = None
    analysis_id: Optional[int] = None


def _read_log_content(db: Session, users_id: str, team_id: str, build_log_id: int):
    log = (
        db.query(LogTable)
        .filter(
            LogTable.users_id == users_id,
            LogTable.team_id == team_id,
            LogTable.build_log_id == build_log_id,
        )
        .first()
    )

    if not log:
        return None, None, "해당 로그를 찾을 수 없습니다."

    if not log.log_path or not os.path.isfile(log.log_path):
        return None, None, "로그 파일을 찾을 수 없습니다."

    try:
        with open(log.log_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"로그 파일 읽기 실패 (build_log_id={build_log_id}, path={log.log_path}): {e}")
        return None, None, "로그 파일을 읽는 중 오류가 발생했습니다."

    # 분석 결과를 어느 로그에 붙일지 알아야 해서 log 행 자체도 함께 돌려준다
    return log, content, None


def _preprocess_log(log_content: str, max_lines: int = 300) -> str:
    """에러/경고/심각/스택트레이스 위주로 추려서 분석 품질과 속도를 높임.
    Java([ERROR]) / Python(ERROR, CRITICAL, Traceback) 등 여러 포맷 대응."""
    lines = log_content.splitlines()

    # 대소문자 무시하고 매칭할 키워드
    keywords_ci = [
        "error", "warn", "warning", "critical", "fatal", "severe",
        "exception", "traceback", "caused by",
        "sigkill", "sigterm", "out of memory", "oom",
        "timeout", "timed out", "refused", "connection reset",
        "failed", "panic", "killed process",
        " 500 ", " 502 ", " 503 ", " 504 ",   # HTTP 에러 상태코드
        "    at ", "  at ",                     # 자바 스택트레이스 들여쓰기
        '  file "',                             # 파이썬 트레이스백 들여쓰기
    ]

    picked = []
    for ln in lines:
        low = ln.lower()
        if any(k in low for k in keywords_ci):
            picked.append(ln)

    # 추릴 게 없으면 마지막 부분이라도 사용
    if not picked:
        picked = lines[-max_lines:]
    elif len(picked) > max_lines:
        picked = picked[-max_lines:]  # 최근 위주

    result = "\n".join(picked)
    if len(result) > MAX_LOG_CHARS:
        result = result[-MAX_LOG_CHARS:]
    return result


def _korean_ratio(text: str) -> float:
    korean = len(re.findall(r"[가-힣]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    total = korean + latin
    if total == 0:
        return 1.0
    return korean / total


def _ollama_chat(messages: list[dict], temperature: float = 0.2) -> str:
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": OLLAMA_MODEL,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            "top_p": 0.8,
        },
        headers={"Content-Type": "application/json"},
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"].strip()


def _rewrite_in_korean(text: str) -> str:
    return _ollama_chat(
        [
            {
                "role": "system",
                "content": (
                    "당신은 한국어 기술 문서 편집자입니다. "
                    "입력 내용의 의미는 유지하되, 설명·제목·문장은 반드시 한국어로만 작성합니다. "
                    "클래스명, 예외명, SQL, 호스트명 같은 기술 식별자만 원문을 유지합니다."
                ),
            },
            {
                "role": "user",
                "content": (
                    "아래 분석 결과를 한국어로만 다시 작성해 주세요. "
                    "영어 제목(예: Recommendations, Database Connection Issues)은 한국어 제목으로 바꿉니다. "
                    "영어 문장은 모두 한국어 문장으로 바꿉니다.\n\n"
                    f"{text}"
                ),
            },
        ],
        temperature=0.1,
    )


def _call_ollama(log_content: str) -> str:
    system = (
        "당신은 한국어로만 답하는 시니어 백엔드/인프라 엔지니어입니다. "
        "모든 제목, 설명, 조치 항목은 한국어로 작성합니다. "
        "영어 제목이나 영어 문장을 사용하지 마세요. "
        "예외 클래스명이나 함수명 같은 기술 식별자만 원문을 유지합니다. "
        "로그에 실제로 나타난 내용만 근거로 분석하고, 로그에 없는 사실은 추측하지 마세요. "
        "지정된 섹션 제목 외의 다른 제목(예: 분석 결과, 결론, 번호 목록)은 절대 사용하지 마세요."
    )

    prompt = (
        "아래 로그를 분석해 주세요. 출력은 아래 예시와 같은 형식으로 한국어로만 작성합니다.\n"
        "단, 예시의 표현을 그대로 베끼지 말고 실제 로그 내용에 맞는 용어를 사용합니다.\n\n"
        "분석 우선순위(중요):\n"
        "- CRITICAL/FATAL 레벨(프로세스 종료, OOM, 서비스 다운, SIGKILL 등)을 최우선으로 보고합니다.\n"
        "- 그다음 ERROR, 그다음 WARNING 순으로 다룹니다.\n"
        "- 발생 횟수가 많은 문제를 우선합니다.\n"
        "- 여러 종류의 에러가 있으면 가장 치명적인 것부터 나열합니다.\n\n"
        "예시 형식:\n"
        "## 핵심 요약\n"
        "- (가장 심각한 문제 1~2개를 한 줄로)\n\n"
        "## 발견된 문제\n"
        "- [심각도] 문제명: 설명 (관련 로그의 시각/로거/클래스, 발생 횟수)\n"
        "  - 심각도는 CRITICAL / HIGH / MEDIUM / LOW 중 하나\n\n"
        "## 추정 원인\n"
        "- 각 문제별 가장 가능성 높은 원인을 근거(로그 라인)와 함께\n\n"
        "## 권장 조치\n"
        "- 바로 실행 가능한 구체적 조치를 우선순위 순으로\n\n"
        "규칙:\n"
        "- 섹션 제목은 반드시 '핵심 요약', '발견된 문제', '추정 원인', '권장 조치'만 사용\n"
        "- 위 네 개 외의 섹션 제목(분석 결과, 결론, 번호 매긴 소제목 등)은 절대 만들지 말 것\n"
        "- 예시의 괄호 안 안내문(예: '(가장 심각한 문제 1~2개를 한 줄로)')은 그대로 출력하지 말 것\n"
        "- 로그에 분석할 오류나 이벤트가 없으면 형식을 채우지 말고 '분석할 만한 오류가 로그에 없습니다.'라고만 답할 것\n"
        "- Recommendations, Database Connection Issues 같은 영어 제목 금지\n"
        "- 로그에 없는 내용은 작성하지 말 것\n"
        "- 추측이 필요하면 '추정:'을 붙일 것\n"
        "- 답변은 반드시 한국어로 작성합니다.\n\n"
        f"로그:\n```\n{log_content}\n```"
    )

    analysis_text = _ollama_chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
    )

    if _korean_ratio(analysis_text) < 0.35:
        analysis_text = _rewrite_in_korean(analysis_text)

    return analysis_text


def _analysis_dir(team_id: str, users_id: str) -> Path:
    return (LOG_ROOT / team_id / users_id / ANALYSIS_DIRNAME).resolve()


def _analysis_query(db: Session, users_id: str, team_id: str):
    return db.query(AiAnalysisTable).filter(
        AiAnalysisTable.users_id == users_id,
        AiAnalysisTable.team_id == team_id,
    )


def _resolve_analysis_file(db: Session, users_id: str, team_id: str, analysis_id: int):
    """분석 행을 찾고, 그 파일이 본인 analyses 디렉터리 안에 있는지까지 확인한다."""
    row = _analysis_query(db, users_id, team_id).filter(
        AiAnalysisTable.analysis_id == analysis_id
    ).first()

    if not row or not row.analysis_path:
        return None, None, "해당 분석 결과를 찾을 수 없습니다."

    path = Path(row.analysis_path).resolve()
    # 경로 이탈 차단: 반드시 본인 analyses 디렉터리 바로 아래 파일이어야 한다
    if path.parent != _analysis_dir(team_id, users_id) or not path.is_file():
        return None, None, "분석 결과 파일을 찾을 수 없습니다."

    return row, path, None


def _prune_analyses(db: Session, users_id: str, team_id: str, build_log_id: int):
    """ANALYSIS_KEEP_PER_LOG가 0보다 클 때만, 로그 1건당 최근 N건을 남기고 정리한다."""
    if ANALYSIS_KEEP_PER_LOG <= 0:
        return

    rows = (
        _analysis_query(db, users_id, team_id)
        .filter(AiAnalysisTable.build_log_id == build_log_id)
        .order_by(AiAnalysisTable.analysis_id.desc())
        .all()
    )

    for row in rows[ANALYSIS_KEEP_PER_LOG:]:
        try:
            if row.analysis_path:
                Path(row.analysis_path).unlink(missing_ok=True)
        except OSError as e:
            print(f"오래된 분석 파일 삭제 실패 (analysis_id={row.analysis_id}): {e}")
        db.delete(row)

    db.commit()


def _save_analysis(db: Session, users_id: str, team_id: str, source_log, analysis_text: str):
    """행을 flush해 analysis_id를 얻고 -> 그 id로 파일명을 지어 쓰고 -> 성공했을 때만 커밋한다.
    이 순서라야 'DB에는 행이 있는데 파일이 없는' 상태가 생기지 않는다.
    파일명에 시각 대신 analysis_id를 쓰는 것은 같은 초에 두 번 재분석해도 겹치지 않게 하기 위함이다."""
    row = AiAnalysisTable(
        build_log_id=source_log.build_log_id,
        users_id=users_id,
        team_id=team_id,
        model=OLLAMA_MODEL,
    )
    db.add(row)
    db.flush()  # analysis_id 확보 (아직 커밋 전)

    src_name = Path(source_log.log_path).name  # 2026-07-21_09-45-26_RUN.log
    out_dir = _analysis_dir(team_id, users_id)
    out_path = out_dir / f"{Path(src_name).stem}_AI_{row.analysis_id}.txt"

    header = (
        "LogPlus AI 분석 리포트\n"
        f"분석 ID   : {row.analysis_id}\n"
        f"대상 로그 : {src_name} (build_log_id={source_log.build_log_id})\n"
        f"모델      : {OLLAMA_MODEL}\n"
        f"생성 시각 : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        + "=" * 60 + "\n\n"
    )

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(header + analysis_text, encoding="utf-8")
    except OSError as e:
        db.rollback()  # 파일을 못 썼으면 행도 남기지 않는다
        print(f"분석 결과 저장 실패 (build_log_id={source_log.build_log_id}, path={out_path}): {e}")
        return None, "분석 결과를 저장하지 못했습니다."

    row.analysis_path = str(out_path)
    db.commit()  # 파일이 확실히 있을 때만 커밋

    _prune_analyses(db, users_id, team_id, source_log.build_log_id)
    return row, None


@router.post("/ai/reanalyze")
def reanalyze(userData: ReanalyzeInput, db: Session = Depends(get_db)):
    source_log, log_content, error_message = _read_log_content(
        db, userData.users_id, userData.team_id, userData.build_log_id
    )
    if error_message:
        return {"status": "fail", "message": error_message}

    # 핵심 라인만 추려서 분석 (속도/정확도 향상)
    analysis_target = _preprocess_log(log_content)

    try:
        analysis_text = _call_ollama(analysis_target)
    except requests.Timeout:
        return {"status": "fail", "message": "AI 분석 요청 시간이 초과되었습니다."}
    except requests.RequestException as e:
        print(f"Ollama 호출 실패: {e}")
        return {"status": "fail", "message": "AI 서버 호출 중 오류가 발생했습니다."}
    except (KeyError, IndexError) as e:
        print(f"Ollama 응답 파싱 실패: {e}")
        return {"status": "fail", "message": "AI 응답을 처리하지 못했습니다."}

    analysis = [line.strip(" -•\t") for line in analysis_text.splitlines() if line.strip()]

    saved, save_error = _save_analysis(
        db, userData.users_id, userData.team_id, source_log, analysis_text
    )
    if save_error:
        return {"status": "fail", "message": save_error}

    return {
        "status": "success",
        "message": "재분석 완료",
        "analysis_id": saved.analysis_id,
        "build_log_id": saved.build_log_id,
        "model": saved.model,
        "created_at": saved.created_at.isoformat() if saved.created_at else None,
        "analysis_text": analysis_text,
        "analysis": analysis,
    }


@router.post("/ai/history")
def ai_history(userData: HistoryInput, db: Session = Depends(get_db)):
    """analysis_id가 없으면 이력 목록, 있으면 그 분석의 본문.
    /db/getLog와 같은 규약이라 프런트가 쓰던 방식 그대로 다룰 수 있다.
    두 경우 모두 Ollama를 호출하지 않으므로 과거 분석 열람은 DB/파일 조회로 끝난다."""
    if userData.analysis_id is None:
        query = _analysis_query(db, userData.users_id, userData.team_id)
        if userData.build_log_id is not None:
            query = query.filter(AiAnalysisTable.build_log_id == userData.build_log_id)

        rows = query.order_by(AiAnalysisTable.created_at.desc()).all()
        if not rows:
            return {"status": "fail", "message": "저장된 분석 이력이 없습니다."}

        return {
            "status": "success",
            "message": "분석 이력 조회 성공",
            "history": [
                {
                    "analysis_id": r.analysis_id,
                    "build_log_id": r.build_log_id,
                    "model": r.model,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ],
        }

    row, path, error_message = _resolve_analysis_file(
        db, userData.users_id, userData.team_id, userData.analysis_id
    )
    if error_message:
        return {"status": "fail", "message": error_message}

    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"분석 파일 읽기 실패 (analysis_id={userData.analysis_id}, path={path}): {e}")
        return {"status": "fail", "message": "분석 결과 파일을 읽는 중 오류가 발생했습니다."}

    return {
        "status": "success",
        "message": "분석 결과 조회 성공",
        "analysis_data": {
            "analysis_id": row.analysis_id,
            "build_log_id": row.build_log_id,
            "model": row.model,
            "analysis_text": content,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        },
    }


@router.get("/ai/download")
def download_analysis(
    users_id: str = Query(...),
    team_id: str = Query(...),
    analysis_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """분석 결과 txt 다운로드. 프런트에서 <a href>로 그대로 이동시키면 CORS가 개입하지 않는다."""
    row, path, error_message = _resolve_analysis_file(db, users_id, team_id, analysis_id)
    if error_message:
        raise HTTPException(status_code=404, detail=error_message)

    filename = f"{users_id}_{path.name}"
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition":
                f'attachment; filename="{filename}"; '
                f"filename*=UTF-8''{quote(filename)}",
        },
    )
