import os
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import uvicorn
from database import engine, get_db, LogTable
from CreateUser import router as create_user_router
from LoginUser import router as login_router
from SelectLogs import router as logs_router
from Aireanalyze import router as ai_router
from GitAuth import router as git_auth_router
from pydantic import BaseModel


class LogInput(BaseModel):
    users_id: str
    team_id: str
    log_type: str
    log_path: str


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(login_router)
app.include_router(create_user_router)
app.include_router(logs_router)
app.include_router(ai_router)
app.include_router(git_auth_router)


@app.get("/")
def read_root():
    return {"status": "ok"}


@app.get("/health")
def health_check():
    try:
        with engine.connect() as conn:
            return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "error", "db": str(e)}


@app.post("/logs")
def save_log(log: LogInput, db: Session = Depends(get_db)):
    user_log_root = Path(
        os.getenv("USER_LOG_ROOT", "/app/logplus-platform/logs")
    ).resolve()
    log_path = Path(log.log_path).resolve()
    expected_dir = (user_log_root / log.team_id / log.users_id).resolve()

    if log_path.parent != expected_dir or not log_path.is_file():
        raise HTTPException(status_code=400, detail="유효한 로그 파일 경로가 아닙니다.")

    new_log = LogTable(
        users_id=log.users_id,
        team_id=log.team_id,
        log_type=log.log_type,
        log_path=str(log_path),
    )
    db.add(new_log)
    db.commit()
    return {"status": "ok", "message": "로그 저장 완료"}


@app.get("/logs/{users_id}")
def get_logs(users_id: str, db: Session = Depends(get_db)):
    logs = db.query(LogTable).filter(LogTable.users_id == users_id).all()
    return logs


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
