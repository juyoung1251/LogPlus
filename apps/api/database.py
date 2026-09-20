from sqlalchemy import create_engine, Column, Integer, String, Text, Enum, TIMESTAMP, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from datetime import datetime

DB_URL = "mysql+pymysql://logplus_app:2ea7dd6f064b15390cab97581a268edd3c3b85ecab914db3@127.0.0.1:3306/LogPlus"
engine = create_engine(DB_URL)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class TeamTable(Base):
    __tablename__ = "teams"
    team_id = Column(String(50), primary_key=True)
    team_name = Column(String(50), nullable=False)
    created_at = Column(TIMESTAMP)


class LogTable(Base):
    __tablename__ = "build_logs"
    build_log_id = Column(Integer, primary_key=True, autoincrement=True)
    users_id = Column(String(100), ForeignKey("users.users_id"))
    team_id = Column(String(50), ForeignKey("teams.team_id"))
    log_type = Column(Enum('run', 'lib'))
    log_path = Column(Text)
    created_at = Column(TIMESTAMP, default=datetime.now)


class UserTable(Base):
    __tablename__ = "users"
    users_id = Column(String(100), primary_key=True)
    password = Column(String(255))
    team_id = Column(String(50), ForeignKey("teams.team_id"))
    role = Column(Enum('admin', 'user'))
    created_at = Column(TIMESTAMP, default=datetime.now)


class AiAnalysisTable(Base):
    """build_logs 한 건에 대한 AI 분석 이력. 재분석할 때마다 행이 1건씩 쌓인다.
    본문은 analysis 컬럼(조회/검색용)과 analysis_path가 가리키는 txt 파일(다운로드용)에 함께 둔다."""
    __tablename__ = "ai_analyses"
    analysis_id = Column(Integer, primary_key=True, autoincrement=True)
    build_log_id = Column(Integer, ForeignKey("build_logs.build_log_id"))
    users_id = Column(String(100))
    team_id = Column(String(100))
    analysis_path = Column(Text)
    created_at = Column(TIMESTAMP, default=datetime.now)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
