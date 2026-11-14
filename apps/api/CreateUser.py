from datetime import datetime
import logging
import os
import re
import shlex
import subprocess

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db, TeamTable, UserTable


router = APIRouter()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
)

USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
TEAM_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")


class RegisterInput(BaseModel):
    users_id: str
    password: str
    team_id: str


@router.post("/user/register")
def register_user(
    userData: RegisterInput,
    db: Session = Depends(get_db),
):
    if not USER_ID_PATTERN.fullmatch(userData.users_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "users_id는 영문·숫자로 시작하는 1~100자의 "
                "영문·숫자·점·밑줄·하이픈이어야 합니다."
            ),
        )

    if not TEAM_ID_PATTERN.fullmatch(userData.team_id):
        raise HTTPException(
            status_code=400,
            detail=(
                "team_id는 영문·숫자로 시작하는 1~50자의 "
                "영문·숫자·점·밑줄·하이픈이어야 합니다."
            ),
        )

    if not userData.password:
        raise HTTPException(
            status_code=400,
            detail="비밀번호를 입력해 주세요.",
        )

    # bcrypt의 비밀번호 길이 제한은 UTF-8 기준 72바이트입니다.
    if len(userData.password.encode("utf-8")) > 72:
        raise HTTPException(
            status_code=400,
            detail="비밀번호는 UTF-8 기준 72바이트 이하여야 합니다.",
        )

    try:
        existing_user = (
            db.query(UserTable)
            .filter(UserTable.users_id == userData.users_id)
            .first()
        )

        if existing_user is not None:
            raise HTTPException(
                status_code=409,
                detail="이미 존재하는 아이디입니다.",
            )

        existing_team = (
            db.query(TeamTable)
            .filter(TeamTable.team_id == userData.team_id)
            .first()
        )

        # 기존 팀이면 일반 사용자, 새 팀이면 관리자
        assigned_role = "user" if existing_team is not None else "admin"
        hashed_password = pwd_context.hash(userData.password)

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
            password=hashed_password,
            team_id=userData.team_id,
            role=assigned_role,
            created_at=datetime.now(),
        )

        db.add(new_user)
        db.flush()

        logger.info(
            "회원가입 준비: users_id=%s, team_id=%s, role=%s",
            userData.users_id,
            userData.team_id,
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
        bare_repo = os.path.join(
            "/repos",
            userData.team_id,
            f"{userData.users_id}.git",
        )

        # 기존 저장소를 재초기화하거나 hook을 덮어쓰지 않도록 차단
        if os.path.lexists(project_dir) or os.path.lexists(bare_repo):
            raise HTTPException(
                status_code=409,
                detail=(
                    "해당 사용자의 프로젝트 경로 또는 저장소가 "
                    "이미 존재합니다. 관리자에게 문의해 주세요."
                ),
            )

        os.makedirs(project_dir, exist_ok=False)
        os.makedirs(os.path.dirname(bare_repo), exist_ok=True)

        subprocess.run(
            ["git", "init", "--bare", bare_repo],
            check=True,
            timeout=30,
            capture_output=True,
            text=True,
        )

        subprocess.run(
            [
                "git",
                "-C",
                bare_repo,
                "config",
                "http.receivepack",
                "true",
            ],
            check=True,
            timeout=30,
            capture_output=True,
            text=True,
        )

        hook_content = (
            "#!/bin/bash\n"
            "while read -r oldrev newrev ref; do\n"
            f"    bash {shlex.quote(builder_script)} "
            f"{shlex.quote(userData.users_id)} "
            f"{shlex.quote(userData.team_id)} || exit $?\n"
            "done\n"
        )

        hook_path = os.path.join(
            bare_repo,
            "hooks",
            "post-receive",
        )

        with open(hook_path, "w", encoding="utf-8") as hook_file:
            hook_file.write(hook_content)

        os.chmod(hook_path, 0o755)

        db.commit()

    except HTTPException:
        db.rollback()
        raise

    except IntegrityError as e:
        db.rollback()
        logger.exception("회원가입 중 데이터베이스 무결성 오류")

        raise HTTPException(
            status_code=409,
            detail=(
                "아이디 또는 팀 정보가 중복되거나 "
                "데이터 제약조건을 위반했습니다."
            ),
        ) from e

    except Exception as e:
        db.rollback()
        logger.exception("회원가입 처리 실패")

        raise HTTPException(
            status_code=500,
            detail="회원가입 처리 중 오류가 발생했습니다.",
        ) from e

    logger.info(
        "회원가입 완료: users_id=%s, role=%s",
        userData.users_id,
        assigned_role,
    )

    return {
        "status": "ok",
        "message": "회원가입 완료",
        "role": assigned_role,
    }