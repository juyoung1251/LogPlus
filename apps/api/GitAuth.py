import base64
import binascii
import re
from typing import Optional, Tuple
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import UserTable, get_db


router = APIRouter()
GIT_PATH_PATTERN = re.compile(
    r"^/git/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/"
    r"([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(?:/.*)?$"
)

# CreateUser.py와 같은 설정이어야 DB에 저장된 해시를 검증할 수 있다
pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
)


def _verify_password(plain_password: str, hashed_password: Optional[str]) -> bool:
    if not hashed_password:
        return False
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except (ValueError, TypeError):
        # 해시가 아닌 값(해시 도입 전에 평문으로 저장된 계정 등)은 인증 실패로 처리
        return False


def _read_basic_credentials(authorization: Optional[str]) -> Tuple[str, str]:
    if not authorization or not authorization.startswith("Basic "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Git 인증 정보가 필요합니다.",
            headers={"WWW-Authenticate": 'Basic realm="LogPlus Git"'},
        )

    try:
        decoded = base64.b64decode(authorization[6:], validate=True).decode("utf-8")
        users_id, password = decoded.split(":", 1)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Git 인증 정보 형식이 올바르지 않습니다.",
            headers={"WWW-Authenticate": 'Basic realm="LogPlus Git"'},
        )

    return users_id, password


def _authenticate_user(authorization: Optional[str], db: Session) -> UserTable:
    auth_users_id, password = _read_basic_credentials(authorization)
    user = db.query(UserTable).filter(UserTable.users_id == auth_users_id).first()
    # DB에는 bcrypt 해시가 저장되므로 평문 비교가 아니라 verify로 검증한다
    if user is None or not _verify_password(password, user.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다.",
            headers={"WWW-Authenticate": 'Basic realm="LogPlus Git"'},
        )
    return user


def _authorize_repository(
    team_id: str, repo_users_id: str, authorization: Optional[str], db: Session
) -> Response:
    user = _authenticate_user(authorization, db)

    if user.users_id != repo_users_id or user.team_id != team_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 저장소에 접근할 권한이 없습니다.",
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/internal/git-auth/{team_id}/{repo_users_id}", status_code=204)
def authorize_git_request(
    team_id: str,
    repo_users_id: str,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    return _authorize_repository(team_id, repo_users_id, authorization, db)


@router.get("/internal/git-auth", status_code=204)
def authorize_nginx_git_request(
    authorization: Optional[str] = Header(default=None),
    x_original_uri: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    original_path = urlsplit(x_original_uri or "").path
    if original_path in {
        "/git/info/refs",
        "/git/git-receive-pack",
        "/git/git-upload-pack",
    }:
        user = _authenticate_user(authorization, db)
        return Response(
            status_code=status.HTTP_204_NO_CONTENT,
            headers={"X-Git-Repo-Path": f"/{user.team_id}/{user.users_id}.git"},
        )

    path_match = GIT_PATH_PATTERN.fullmatch(original_path)
    if not path_match:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Git 저장소 경로가 올바르지 않습니다.",
        )

    team_id, repo_users_id = path_match.groups()
    return _authorize_repository(team_id, repo_users_id, authorization, db)
