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
class RegisterInput(BaseModel): # 회원가입 요청 데이터
    users_id: str
    password: str
    team_id: str
    role: str

@router.post("/user/register")
def register_user(userData: RegisterInput, db: Session = Depends(get_db)):
    path_component_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
    if not path_component_pattern.fullmatch(userData.users_id):
        raise HTTPException(status_code=400, detail="users_id 형식이 올바르지 않습니다.")
    if not path_component_pattern.fullmatch(userData.team_id):
        raise HTTPException(status_code=400, detail="team_id 형식이 올바르지 않습니다.")

    existing_user = db.query(UserTable).filter(UserTable.users_id == userData.users_id).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="이미 존재하는 아이디입니다.")

    existing_team = db.query(TeamTable).filter(TeamTable.team_id == userData.team_id).first()
    # if existing_team is None:
    #     raise HTTPException(
    #     status_code=400,
    #     detail=f"존재하지 않는 팀입니다: {userData.team_id}. 등록된 team_id를 입력하세요.",
    #     )
    logging.info(f"1###############db.flush()#############")

    new_user = UserTable(
        users_id=userData.users_id,
        password=userData.password,
        team_id=userData.team_id,
        role=userData.role,
        created_at=datetime.now()
    )


    try:
        db.add(new_user)
        if existing_team is None:
            new_team = TeamTable(
                team_id=userData.team_id,
                team_name=userData.team_id,
                created_at=datetime.now()
            )
            db.add(new_team)
        db.flush()
        logging.info(f"2###############db.flush()#############" + new_user.users_id)

        project_root = os.getenv("PROJECT_ROOT", "/app/logplus-platform/projects")
        builder_script = os.getenv(
            "BUILDER_SCRIPT", "/app/logplus-platform/services/builder/build.sh"
        )
        project_dir = os.path.join(project_root, userData.team_id, userData.users_id)
        os.makedirs(project_dir, exist_ok=True)

        bare_repo = f"/repos/{userData.team_id}/{userData.users_id}.git"
        os.makedirs(os.path.dirname(bare_repo), exist_ok=True)
        subprocess.run(["git", "init", "--bare", bare_repo], check=True)
        subprocess.run(
            ["git", "-C", bare_repo, "config", "http.receivepack", "true"],
            check=True,
        )

        hook_content = (
            "#!/bin/bash\n"
            "while read oldrev newrev ref; do\n"
            f'    bash {shlex.quote(builder_script)} '
            f'"{userData.users_id}" "{userData.team_id}"\n'
            "done\n"
        )
        hook_path = f"{bare_repo}/hooks/post-receive"
        with open(hook_path, "w") as f:
            f.write(hook_content)
        os.chmod(hook_path, 0o755)
        db.commit()

    except IntegrityError as e:
        db.rollback()
        if "users_teams_FK" in str(e):
            raise HTTPException(
                status_code=400,
                detail=f"존재하지 않는 팀입니다: {userData.team_id}. 등록된 team_id를 입력하세요.",
            ) from e
        raise HTTPException(status_code=500, detail="회원가입 중 데이터베이스 오류가 발생했습니다.") from e
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"회원가입 중 오류가 발생했습니다: {str(e)}")

    return {"status": "ok", "message": "회원가입 완료"}
