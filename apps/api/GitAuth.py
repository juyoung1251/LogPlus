import base64
import binascii
import secrets
import re
from typing import Optional, Tuple
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy.orm import Session

from database import UserTable, get_db


router = APIRouter()
GIT_PATH_PATTERN = re.compile(
    r"^/git/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/"
    r"([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(?:/.*)?$"
)


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


def _authorize_repository(
    team_id: str, repo_users_id: str, authorization: Optional[str], db: Session
) -> Response:
    auth_users_id, password = _read_basic_credentials(authorization)
    user = db.query(UserTable).filter(UserTable.users_id == auth_users_id).first()

    credentials_match = (
        user is not None
        and secrets.compare_digest(user.password, password)
    )
    if not credentials_match:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다.",
            headers={"WWW-Authenticate": 'Basic realm="LogPlus Git"'},
        )

    if user.users_id != repo_users_id or user.team_id != team_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 저장소에 접근할 권한이 없습니다.",
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _authenticate_user(authorization: Optional[str], db: Session) -> UserTable:
    auth_users_id, password = _read_basic_credentials(authorization)
    user = db.query(UserTable).filter(UserTable.users_id == auth_users_id).first()
    if user is None or not secrets.compare_digest(user.password, password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다.",
            headers={"WWW-Authenticate": 'Basic realm="LogPlus Git"'},
        )
    return user


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
