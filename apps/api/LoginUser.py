import logging
import os
import re
import shutil

import bcrypt
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from database import (
    get_db,
    UserTable,
    TeamTable,
    LogTable,
    AiAnalysisTable,
)


router = APIRouter()
logger = logging.getLogger(__name__)

PATH_COMPONENT_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
)


class LoginInput(BaseModel):
    users_id: str
    password: str


def verify_password(
    plain_password: str,
    hashed_password: str,
) -> bool:
    if not isinstance(hashed_password, str):
        return False

    password_bytes = plain_password.encode("utf-8")

    if not password_bytes or len(password_bytes) > 72:
        return False

    try:
        return bcrypt.checkpw(
            password_bytes,
            hashed_password.encode("utf-8"),
        )
    except (ValueError, TypeError):
        return False


def delete_related_data(
    db: Session,
    target_user_ids: list,
):
    """
    대상 계정들의 학습 데이터, AI 분석, 빌드 로그 삭제.
    commit은 del_user()에서 수행합니다.
    """
    if not target_user_ids:
        return

    # 대상 계정들의 빌드 로그 ID 조회
    log_ids = [
        row.build_log_id
        for row in (
            db.query(LogTable.build_log_id)
            .filter(LogTable.users_id.in_(target_user_ids))
            .all()
        )
    ]

    if log_ids:
        # 1. 학습 데이터 삭제
        db.execute(
            text(
                "DELETE FROM ai_training_examples "
                "WHERE users_id IN :user_ids "
                "OR build_log_id IN :log_ids"
            ).bindparams(
                bindparam("user_ids", expanding=True),
                bindparam("log_ids", expanding=True),
            ),
            {
                "user_ids": target_user_ids,
                "log_ids": log_ids,
            },
        )

        # 2. AI 분석 데이터 삭제
        db.query(AiAnalysisTable).filter(
            AiAnalysisTable.users_id.in_(target_user_ids)
            | AiAnalysisTable.build_log_id.in_(log_ids)
        ).delete(synchronize_session=False)

    else:
        # 빌드 로그가 없어도 사용자 ID로 연결된 데이터 삭제
        db.execute(
            text(
                "DELETE FROM ai_training_examples "
                "WHERE users_id IN :user_ids"
            ).bindparams(
                bindparam("user_ids", expanding=True)
            ),
            {"user_ids": target_user_ids},
        )

        db.query(AiAnalysisTable).filter(
            AiAnalysisTable.users_id.in_(target_user_ids)
        ).delete(synchronize_session=False)

    # 3. 학습·분석 데이터를 삭제한 다음 빌드 로그 삭제
    db.query(LogTable).filter(
        LogTable.users_id.in_(target_user_ids)
    ).delete(synchronize_session=False)


@router.post("/user/login")
def login_user(
    userData: LoginInput,
    db: Session = Depends(get_db),
):
    user = (
        db.query(UserTable)
        .filter(UserTable.users_id == userData.users_id)
        .first()
    )

    if user is None:
        return {
            "status": "fail",
            "message": "존재하지 않는 아이디입니다.",
        }

    if not verify_password(userData.password, user.password):
        return {
            "status": "fail",
            "message": "비밀번호가 일치하지 않습니다.",
        }

    return {
        "status": "success",
        "message": f"{user.users_id}님 환영합니다!",
        "user_info": {
            "users_id": user.users_id,
            "team_id": user.team_id,
        },
    }


@router.post("/user/delUser")
def del_user(
    userData: LoginInput,
    db: Session = Depends(get_db),
):
    # 사용자 조회
    user = (
        db.query(UserTable)
        .filter(UserTable.users_id == userData.users_id)
        .first()
    )

    if user is None:
        return {
            "status": "fail",
            "message": "존재하지 않는 아이디입니다.",
        }

    # 비밀번호 해시 검증
    if not verify_password(userData.password, user.password):
        return {
            "status": "fail",
            "message": "비밀번호가 일치하지 않습니다.",
        }

    users_id = user.users_id
    users_role = user.role
    team_id = user.team_id

    logger.info(
        "탈퇴 요청: users_id=%s, team_id=%s, role=%s",
        users_id,
        team_id,
        users_role,
    )

    # 삭제 경로에 사용할 값 검증
    if not (
        isinstance(team_id, str)
        and isinstance(users_id, str)
        and PATH_COMPONENT_PATTERN.fullmatch(team_id)
        and PATH_COMPONENT_PATTERN.fullmatch(users_id)
    ):
        return {
            "status": "fail",
            "message": "계정 정보가 올바르지 않아 탈퇴할 수 없습니다.",
        }

    if users_role not in ("admin", "user"):
        return {
            "status": "fail",
            "message": "권한이 올바르지 않아 탈퇴할 수 없습니다.",
        }

    project_root = os.getenv(
        "PROJECT_ROOT",
        "/app/logplus-platform/projects",
    )
    log_root = os.getenv(
        "USER_LOG_ROOT",
        "/app/logplus-platform/logs",
    )

    # 권한별 파일 삭제 경로
    if users_role == "admin":
        # 팀 전체 디렉터리 삭제
        del_paths = [
            os.path.join(project_root, team_id),
            os.path.join(log_root, team_id),
            os.path.join("/repos", team_id),
        ]

    else:
        # 일반 사용자는 본인 디렉터리만 삭제
        del_paths = [
            os.path.join(project_root, team_id, users_id),
            os.path.join(log_root, team_id, users_id),
            os.path.join(
                "/repos",
                team_id,
                f"{users_id}.git",
            ),
        ]

    # DB 데이터 삭제
    try:
        if users_role == "admin":
            # 1. 같은 팀의 계정 목록 확보
            # 요청한 관리자 본인은 제외
            user_list = [
                row.users_id
                for row in (
                    db.query(UserTable.users_id)
                    .filter(
                        UserTable.team_id == team_id,
                        UserTable.users_id != users_id,
                    )
                    .all()
                )
            ]

            # 관련 데이터 삭제 대상에는 관리자도 포함
            target_user_ids = user_list + [users_id]

            logger.info(
                "팀 전체 삭제 시작: team_id=%s, 계정수=%s",
                team_id,
                len(target_user_ids),
            )

            # 2. 팀원·관리자의 학습 데이터, AI 분석, 로그 삭제
            delete_related_data(db, target_user_ids)

            # 3. 팀원 계정 먼저 삭제
            if user_list:
                db.query(UserTable).filter(
                    UserTable.team_id == team_id,
                    UserTable.users_id.in_(user_list),
                ).delete(synchronize_session=False)

            # 4. 관리자 계정 삭제
            db.query(UserTable).filter(
                UserTable.team_id == team_id,
                UserTable.users_id == users_id,
            ).delete(synchronize_session=False)

            # 5. 팀 정보 삭제
            db.query(TeamTable).filter(
                TeamTable.team_id == team_id
            ).delete(synchronize_session=False)

        else:
            target_user_ids = [users_id]

            # 1. 본인의 학습 데이터, AI 분석, 로그 삭제
            delete_related_data(db, target_user_ids)

            # 2. 본인 계정 삭제
            # 팀 정보와 다른 팀원은 유지
            db.query(UserTable).filter(
                UserTable.team_id == team_id,
                UserTable.users_id == users_id,
            ).delete(synchronize_session=False)

        # 전체 DB 삭제 성공 시 한 번만 commit
        db.commit()

        logger.info(
            "delUser DB 삭제 완료: team_id=%s, 계정수=%s",
            team_id,
            len(target_user_ids),
        )

    except Exception:
        db.rollback()

        logger.exception(
            "delUser DB 삭제 실패: team_id=%s, users_id=%s",
            team_id,
            users_id,
        )

        return {
            "status": "fail",
            "message": "탈퇴 처리 중 오류가 발생했습니다.",
        }

    # DB commit 성공 후 파일 삭제
    # 이 부분은 위 except 바깥에 있어야 합니다.
    failed_paths = []

    for path in del_paths:
        try:
            if os.path.islink(path):
                # 심볼릭 링크는 링크 자체만 삭제
                os.unlink(path)

            elif os.path.isdir(path):
                # 하위 파일과 디렉터리까지 삭제
                shutil.rmtree(path)

            elif os.path.exists(path):
                os.remove(path)

            else:
                logger.info(
                    "delUser 삭제 대상 경로 없음: %s",
                    path,
                )
                continue

            logger.info(
                "delUser 경로 삭제 완료: %s",
                path,
            )

        except Exception:
            logger.exception(
                "delUser 경로 삭제 실패: %s",
                path,
            )
            failed_paths.append(path)

    if users_role == "admin":
        message = (
            f"{team_id} 팀과 관리자 포함 "
            f"{len(target_user_ids)}개 계정이 삭제되었습니다."
        )
    else:
        message = f"{users_id} 계정이 탈퇴되었습니다."

    if failed_paths:
        message += (
            " 일부 파일 삭제에 실패했습니다. "
            "서버 로그를 확인해 주세요."
        )

    return {
        "status": "success",
        "message": message,
        "cleanup_pending": bool(failed_paths),
    }