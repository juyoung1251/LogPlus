from fastapi import APIRouter, Depends
from sqlalchemy import text, bindparam
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db, UserTable, LogTable, AiAnalysisTable
import os
import re
import shutil
import logging
router = APIRouter()


class LoginInput(BaseModel):
    users_id: str
    password: str

@router.post("/user/login")
def login_user(userData: LoginInput, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.users_id == userData.users_id).first()

    if not user:
        return {
                "status": "fail", 
                "message": f"존재하지 않는 아이디입니다.",
                }

    if not userData.password == user.password:
        return {
                "status": "fail", 
                "message": f"비밀번호가 일치하지 않습니다.",
                }

    return {
            "status": "success", 
            "message": f"{user.users_id}님 환영합니다!",
            "user_info": {
                "users_id": user.users_id,
                "team_id" : user.team_id,
                }
            }
@router.post("/user/delUser")
def del_user(userData: LoginInput, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.users_id == userData.users_id).first()

    if not user:
        return {
                "status": "fail",
                "message": f"존재하지 않는 아이디입니다.",
                }
    if not userData.password == user.password:
        return {
                "status": "fail",
                "message": f"비밀번호가 일치하지 않습니다.",
                }

    users_id = user.users_id
    team_id = user.team_id

    path_component_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
    if not (team_id and path_component_pattern.fullmatch(team_id)
            and path_component_pattern.fullmatch(users_id)):
        return {
                "status": "fail",
                "message": "계정 정보가 올바르지 않아 탈퇴할 수 없습니다.",
                }

    try:
        log_ids = [row.build_log_id for row in
                   db.query(LogTable.build_log_id).filter(LogTable.users_id == users_id).all()]

        if log_ids:
            db.execute(
                text("DELETE FROM ai_training_examples WHERE users_id = :uid OR build_log_id IN :ids")
                .bindparams(bindparam("ids", expanding=True)),
                {"uid": users_id, "ids": log_ids},
            )
            db.query(AiAnalysisTable).filter(
                (AiAnalysisTable.users_id == users_id) | AiAnalysisTable.build_log_id.in_(log_ids)
            ).delete(synchronize_session=False)
        else:
            db.execute(text("DELETE FROM ai_training_examples WHERE users_id = :uid"), {"uid": users_id})
            db.query(AiAnalysisTable).filter(AiAnalysisTable.users_id == users_id).delete(synchronize_session=False)

        db.query(LogTable).filter(LogTable.users_id == users_id).delete(synchronize_session=False)
        db.delete(user)
        db.commit()
    except Exception as e:
        db.rollback()
        logging.exception("delUser DB 삭제 실패: %s", users_id)
        return {
                "status": "fail",
                "message": f"탈퇴 처리 중 오류가 발생했습니다: {str(e)}",
                }

    project_root = os.getenv("PROJECT_ROOT", "/app/logplus-platform/projects")
    log_root = os.getenv("USER_LOG_ROOT", "/app/logplus-platform/logs")
    del_paths = [
        os.path.join(project_root, team_id, users_id),
        os.path.join(log_root, team_id, users_id),
        f"/repos/{team_id}/{users_id}.git",
    ]
    failed_paths = []
    for path in del_paths:
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
        except Exception:
            logging.exception("delUser 경로 삭제 실패: %s", path)
            failed_paths.append(path)

    if failed_paths:
        return {
                "status": "success",
                "message": f"{users_id}계정이 탈퇴 되었습니다. (일부 파일 삭제 실패: {', '.join(failed_paths)})",
                }

    return {
            "status": "success",
            "message": f"{users_id}계정이 탈퇴 되었습니다.",
            }
