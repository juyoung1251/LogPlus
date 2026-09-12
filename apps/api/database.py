import os

from sqlalchemy import create_engine, Column, Integer, String, Text, Enum, TIMESTAMP, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from datetime import datetime

DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("DATABASE_URL 환경변수가 필요합니다. apps/api/.env.example을 참고하세요.")
engine = create_engine(DB_URL)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class LogTable(Base):
    __tablename__ = "build_logs"
    build_log_id = Column(Integer, primary_key=True, autoincrement=True)
    users_id = Column(String(100), ForeignKey("users.users_id"))
    team_id = Column(String(100), ForeignKey("users.team_id"))
    log_type = Column(Enum('run', 'lib'))
    log_path = Column(Text)
    created_at = Column(TIMESTAMP, default=datetime.now)


class UserTable(Base):
    __tablename__ = "users"
    users_id = Column(String(100), primary_key=True)
    username = Column(String(100))
    password = Column(String(100))
    team_id = Column(String(50))
    role = Column(Enum('admin', 'user'))
    created_at = Column(TIMESTAMP, default=datetime.now)


class AiAnalysisTable(Base):
    """build_logs 한 건에 대한 AI 분석 이력. 재분석할 때마다 행이 1건씩 쌓인다.
    본문은 analysis_path가 가리키는 txt 파일에 있고, 이 테이블은 메타데이터만 보관한다."""
    __tablename__ = "ai_analyses"
    analysis_id = Column(Integer, primary_key=True, autoincrement=True)
    build_log_id = Column(Integer, ForeignKey("build_logs.build_log_id"))
    users_id = Column(String(100))
    team_id = Column(String(100))
    model = Column(String(100))
    analysis_path = Column(Text)
    created_at = Column(TIMESTAMP, default=datetime.now)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
