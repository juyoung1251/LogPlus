from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime
from database import get_db, UserTable
import os
import re
import subprocess

router = APIRouter()

class RegisterInput(BaseModel): # 회원가입 요청 데이터
    users_id: str
    username: str
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

    new_user = UserTable(
        users_id=userData.users_id,
        username=userData.username,
        password=userData.password,
        team_id=userData.team_id,
        role=userData.role,
        created_at=datetime.now()
    )

    try:
        db.add(new_user)
        db.flush()

        project_dir = f"/app/logplus/projects/{userData.team_id}/{userData.users_id}"
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
            f'    bash /app/logplus/builder/build.sh "{userData.users_id}" "{userData.team_id}" "{userData.username}"\n'
            "done\n"
        )
        hook_path = f"{bare_repo}/hooks/post-receive"
        with open(hook_path, "w") as f:
            f.write(hook_content)
        os.chmod(hook_path, 0o755)
        db.commit()

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"회원가입 중 오류가 발생했습니다: {str(e)}")

    return {"status": "ok", "message": "회원가입 완료"}
