import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db, UserTable, LogTable, AiAnalysisTable

router = APIRouter()


class ChangePasswordInput(BaseModel):
    users_id: str
    current_password: str
    new_password: str


# 설정 페이지를 열 때 한 번에 부른다: 내 정보 · 활동 수 · 팀원 목록
@router.get("/user/settings")
def user_settings(users_id: str, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.users_id == users_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="존재하지 않는 아이디입니다.")

    # build.sh는 빌드 1회마다 run 로그를 1건 등록한다 (lib 로그는 설치 단계라 빼고 센다)
    build_count = db.query(LogTable).filter(
        LogTable.users_id == users_id,
        LogTable.log_type == "run",
    ).count()
    ai_count = db.query(AiAnalysisTable).filter(AiAnalysisTable.users_id == users_id).count()

    teammates = [
        row.users_id for row in
        db.query(UserTable.users_id)
        .filter(UserTable.team_id == user.team_id)
        .order_by(UserTable.users_id)
        .all()
    ]

    return {
        "users_id": user.users_id,
        "team_id": user.team_id,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "build_count": build_count,
        "ai_count": ai_count,
        "teammates": teammates,
    }


# 로그인과 같은 평문 저장. git push 인증(GitAuth.py)도 같은 값을 쓰므로 함께 바뀐다
@router.post("/user/changePassword")
def change_password(userData: ChangePasswordInput, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.users_id == userData.users_id).first()

    if not user:
        return {
                "status": "fail",
                "message": "존재하지 않는 아이디입니다.",
                }
    if not secrets.compare_digest(user.password or "", userData.current_password):
        return {
                "status": "fail",
                "message": "현재 비밀번호가 일치하지 않습니다.",
                }
    if not userData.new_password:
        return {
                "status": "fail",
                "message": "새 비밀번호를 입력해주세요.",
                }

    user.password = userData.new_password
    db.commit()
    return {
            "status": "success",
            "message": "비밀번호가 변경되었습니다.",
            }
