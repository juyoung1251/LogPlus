import os
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db, LogTable

router = APIRouter()

class DBInput(BaseModel):
    users_id: str
    team_id: str
    build_log_id: Optional[int] = None

def _base_query(db: Session, users_id: str, team_id: str):
    return db.query(LogTable).filter(
        LogTable.users_id == users_id,
        LogTable.team_id == team_id,
    )

@router.post("/db/getLog")
def getDB(userData: DBInput, db: Session = Depends(get_db)):
    # ── 1) build_log_id 없음 → 로그 목록 조회 ──
    if userData.build_log_id is None:
        logs = _base_query(db, userData.users_id, userData.team_id).order_by(
            LogTable.created_at.desc()
        ).all()

        if not logs:
            return {
                "status": "fail",
                "message": "해당 계정에 대한 로그가 존재하지 않습니다.",
            }

        return {
            "status": "success",
            "message": "로그 목록 조회 성공",
            "log_list": [
                {
                    "build_log_id": log.build_log_id,
                    "log_type": log.log_type,
                    "created_at": log.created_at.isoformat() if log.created_at else None,
                }
                for log in logs
            ],
        }

    # ── 2) build_log_id 있음 → 개별 로그 내용 조회 ──
    log = _base_query(db, userData.users_id, userData.team_id).filter(
        LogTable.build_log_id == userData.build_log_id
    ).first()

    if not log:
        return {
            "status": "fail",
            "message": "해당 로그를 찾을 수 없습니다.",
        }

    # log_path가 가리키는 파일을 읽어 내용 추출
    content = None
    try:
        if log.log_path and os.path.isfile(log.log_path):
            with open(log.log_path, "r", encoding="utf-8") as f:
                content = f.read()
        else:
            return {
                "status": "fail",
                "message": "로그 파일을 찾을 수 없습니다.",
            }
    except Exception as e:
        print(f"로그 파일 읽기 실패 (build_log_id={log.build_log_id}, path={log.log_path}): {e}")
        return {
            "status": "fail",
            "message": "로그 파일을 읽는 중 오류가 발생했습니다.",
        }

    return {
        "status": "success",
        "message": "로그 내용 조회 성공",
        "log_data": {
            "build_log_id": log.build_log_id,
            "log_type": log.log_type,
            "log_content": content,          # 경로가 아니라 실제 파일 내용
            "created_at": log.created_at.isoformat() if log.created_at else None,
        },
    }