# LogPlus Platform

GitHub 배포용 소스 구조입니다. 운영 데이터와 도구 설치 파일은 포함하지 않습니다.

전체 구조와 운영 원본의 매핑은 [docs/STRUCTURE.md](docs/STRUCTURE.md)를 참고하세요.

## Layout

- `apps/web`: React/Vite 웹 클라이언트
- `apps/api`: FastAPI API
- `services/builder`: Git push 뒤 사용자 프로젝트를 Docker로 빌드하는 서비스
- `infra`: Nginx, systemd, n8n 배포 템플릿
- `docs`: 구조 및 운영 문서
- `examples`: 테스트용 사용자 프로젝트

## Local setup

1. `apps/api/.env.example`을 `apps/api/.env`로 복사해 실제 `DATABASE_URL`을 설정합니다.
2. `apps/web/.env.example`을 `apps/web/.env`로 복사해 API 주소를 설정합니다.
3. `apps/web`에서 `npm ci && npm run dev`를 실행합니다.
4. `apps/api`에서 `pip install -r requirements.txt` 후 `uvicorn main:app --reload`를 실행합니다.

`infra/n8n/.env.example`은 n8n Compose용 예시입니다. 실제 `.env`와 Docker 볼륨, MariaDB 데이터, `/repos`, 빌드 로그 및 사용자 작업본은 GitHub에 올리지 않습니다.

## Production note

현재 운영 배치 경로는 `/app/logplus`입니다. 이 저장소의 디렉터리 구조는 소스 관리용이므로, 운영 경로를 바꾸려면 systemd 유닛, Git hook, builder 설정을 함께 변경해야 합니다.
