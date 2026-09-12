from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db, UserTable
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
            "message": f"{user.username}님 환영합니다!",
            "user_info": {
                "users_id": user.users_id,
                "username": user.username,
                "team_id" : user.team_id,
                }
            }
