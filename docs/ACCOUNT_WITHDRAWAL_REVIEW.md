# 회원 탈퇴 삭제 대상 확인

확인일: 2026-10-17 (Asia/Seoul)
범위: /app/logplus-platform 소스 및 해당 API가 연결하는 LogPlus DB의 스키마.
실제 사용자 데이터 삭제, 서비스 변경, /repos 접근은 하지 않았다.

## 파일 경로

표시 이름이 아니라 DB의 team_id(프로젝트 식별자), users_id(사용자 아이디)를 사용한다.

| 대상 | 기본 경로 | 처리 |
| --- | --- | --- |
| 사용자 작업본 | /app/logplus-platform/projects/{team_id}/{users_id} | 사용자 디렉터리만 삭제 |
| 사용자 로그 | /app/logplus-platform/logs/{team_id}/{users_id} | 하위 analyses/의 AI 분석 TXT까지 삭제 |
| bare Git 저장소 | /repos/{team_id}/{users_id}.git | 사용자 저장소만 삭제; 이번 확인에서는 직접 접근 생략 |

projects와 logs의 루트는 각각 PROJECT_ROOT, USER_LOG_ROOT 환경변수로 바뀔 수 있다.
실행 중인 프로세스의 적용값과 /repos 실물 존재·권한은 이번에 확인하지 않았다.
각 경로의 {team_id} 부모 디렉터리와 다른 사용자의 데이터는 유지한다.
근거: CreateUser.py:62-69, services/builder/build.sh:24-39, Aireanalyze.py:377-378.

## DB 삭제 대상과 순서

실제 DB에서 확인한 테이블은 teams, users, build_logs, ai_analyses, ai_training_examples다.
대상 사용자는 비밀번호 확인 후 users 행에서 확정한 users_id/team_id를 사용한다.

1. ai_training_examples: 대상 사용자의 사례. users_id/team_id뿐 아니라 대상 build_log_id 또는 analysis_id를 참조하는 사례도 확인한다. 이 테이블에는 외래키가 없어 자동으로 정리되지 않는다.
2. ai_analyses: 대상 사용자의 분석 이력 및 대상 build_log_id에 연결된 분석 이력. 과거 소유자 컬럼 누락도 고려해 로그 ID 관계로 확인한다.
3. build_logs: 대상 사용자의 빌드 로그(lib/run). 사용자가 여러 프로젝트에 남긴 과거 행이 있다면 계정 전체 탈퇴 범위에 포함할지 확인한다.
4. users: 대상 users_id의 계정 1건.
5. teams: 유지한다. 마지막 사용자라도 이번 요구사항에서는 프로젝트를 삭제하지 않는다.

삭제 전에 대상 로그·분석 ID를 확보하고, DB 변경은 하나의 트랜잭션으로 처리하는 것이 적절하다.
다른 사용자 소유 데이터와 연결이 충돌하면 일괄 삭제하지 말고 관계 오류를 확인한다.
다른 사용자의 사례에서 verified_by에만 탈퇴 아이디가 남는 경우, 사례 전체 삭제 대신 해당 검증자 식별자 제거/익명화 범위를 별도로 정한다.

실제 외래키 DELETE_RULE:
- ai_analyses -> build_logs: RESTRICT
- ai_analyses -> users: CASCADE
- ai_analyses -> teams: CASCADE
- build_logs -> users: RESTRICT
- build_logs -> teams: CASCADE
- users -> teams: RESTRICT

따라서 users만 먼저 지우면 build_logs 때문에 실패한다. teams 삭제는 여러 사용자 로그/분석에 영향을 주므로 수행하면 안 된다.

## 추가 사본 및 진행 중 작업

- train_logplus.sh는 기본 apps/api/training-output 아래에 로그와 분석 본문의 추출 사본을 만들고 외부 학습 API로 보낼 수 있다. 실제 생성·전송 여부는 미확인이다. 생성된 사본이 있으면 해당 사용자 build_log_id/analysis_id 기준으로 함께 정리해야 한다. 프로젝트 전체 추출 폴더를 무조건 지우지 않는다.
- 빌드가 진행 중이면 디렉터리 재생성과 뒤늦은 로그 등록 가능성이 있으므로 해당 사용자 작업 종료/차단을 삭제 절차에 포함한다. 빌더 이미지 이름은 {users_id}-{team_id}이며 운영 Docker에는 접근하지 않았다.
- API/빌더 공용 로그는 사용자 전용 디렉터리가 아니므로 파일 전체를 삭제하지 않는다.

## 현재 구현 상태와 검증

- LoginUser.py의 POST /user/delUser에는 사용자/비밀번호 확인만 있고 삭제 로직이 없다.
- 성공 return은 비밀번호 불일치 분기의 실패 return 뒤에 있어 실행되지 않는다. 정상 비밀번호 요청은 함수 끝으로 떨어져 None을 반환한다.
- 계정 관리 화면 User.tsx는 준비 중이며 탈퇴 API 호출이 없다.
- 소스/AST 확인과 information_schema 테이블·컬럼·외래키·DELETE_RULE 조회만 수행했다. DB 조회는 읽기 전용 트랜잭션 뒤 rollback했다.
- package.json/package-lock.json 및 API requirements.txt를 확인했다. 이번 작업은 기존 업무 로직·구조 검토이며 라이브러리 API 사용법 변경은 없다.
- 탈퇴 구현·실제 삭제·탈퇴 통합 테스트는 수행하지 않았다.
