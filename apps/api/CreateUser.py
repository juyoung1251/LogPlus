from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime
from database import get_db, TeamTable, UserTable
import os
import re
import shlex
import subprocess
import logging

router = APIRouter()
logging.basicConfig(level=logging.INFO)


class RegisterInput(BaseModel):
    users_id: str
    password: str
    team_id: str


@router.post("/user/register")
def register_user(userData: RegisterInput, db: Session = Depends(get_db)):
    user_id_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
    team_id_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")

    if not user_id_pattern.fullmatch(userData.users_id):
        raise HTTPException(
            status_code=400,
            detail="users_id는 영문·숫자로 시작하는 1~100자의 영문·숫자·점·밑줄·하이픈이어야 합니다.",
        )

    if not team_id_pattern.fullmatch(userData.team_id):
        raise HTTPException(
            status_code=400,
            detail="team_id는 영문·숫자로 시작하는 1~50자의 영문·숫자·점·밑줄·하이픈이어야 합니다.",
        )

    try:
        existing_user = (
            db.query(UserTable)
            .filter(UserTable.users_id == userData.users_id)
            .first()
        )

        if existing_user is not None:
            raise HTTPException(
                status_code=400,
                detail="이미 존재하는 아이디입니다.",
            )

        existing_team = (
            db.query(TeamTable)
            .filter(TeamTable.team_id == userData.team_id)
            .first()
        )

        # 기존 팀이면 일반 사용자, 새 팀이면 관리자
        assigned_role = "user" if existing_team is not None else "admin"

        if existing_team is None:
            new_team = TeamTable(
                team_id=userData.team_id,
                team_name=userData.team_id,
                created_at=datetime.now(),
            )
            db.add(new_team)

            # 사용자 외래키가 참조할 팀을 먼저 저장
            db.flush()

        new_user = UserTable(
            users_id=userData.users_id,
            password=userData.password,
            team_id=userData.team_id,
            role=assigned_role,
            created_at=datetime.now(),
        )

        db.add(new_user)
        db.flush()

        logging.info(
            "회원가입 준비: users_id=%s, team_id=%s, role=%s",
            new_user.users_id,
            new_user.team_id,
            assigned_role,
        )

        project_root = os.getenv(
            "PROJECT_ROOT",
            "/app/logplus-platform/projects",
        )
        builder_script = os.getenv(
            "BUILDER_SCRIPT",
            "/app/logplus-platform/services/builder/build.sh",
        )

        project_dir = os.path.join(
            project_root,
            userData.team_id,
            userData.users_id,
        )
        os.makedirs(project_dir, exist_ok=True)

        bare_repo = f"/repos/{userData.team_id}/{userData.users_id}.git"
        os.makedirs(os.path.dirname(bare_repo), exist_ok=True)

        subprocess.run(
            ["git", "init", "--bare", bare_repo],
            check=True,
        )
        subprocess.run(
            ["git", "-C", bare_repo, "config", "http.receivepack", "true"],
            check=True,
        )

        hook_content = (
            "#!/bin/bash\n"
            "while read oldrev newrev ref; do\n"
            f"    bash {shlex.quote(builder_script)} "
            f"{shlex.quote(userData.users_id)} "
            f"{shlex.quote(userData.team_id)}\n"
            "done\n"
        )

        hook_path = os.path.join(bare_repo, "hooks", "post-receive")

        with open(hook_path, "w", encoding="utf-8") as hook_file:
            hook_file.write(hook_content)

        os.chmod(hook_path, 0o755)

        db.commit()

        logging.info(
            "회원가입 완료: users_id=%s, role=%s",
            userData.users_id,
            assigned_role,
        )

    except HTTPException:
        db.rollback()
        raise

    except IntegrityError as e:
        db.rollback()
        logging.exception("회원가입 중 데이터베이스 무결성 오류")

        if "users_teams_FK" in str(e):
            raise HTTPException(
                status_code=400,
                detail="팀 정보를 저장하지 못했습니다. 다시 시도하세요.",
            ) from e

        raise HTTPException(
            status_code=409,
            detail="아이디 또는 팀 정보가 중복되거나 데이터 제약조건을 위반했습니다.",
        ) from e

    except Exception as e:
        db.rollback()
        logging.exception("회원가입 처리 실패")

        raise HTTPException(
            status_code=500,
            detail=f"회원가입 중 오류가 발생했습니다: {str(e)}",
        ) from e

    return {
        "status": "ok",
        "message": "회원가입 완료",
        "role": assigned_role,
    }
