# LogPlus Platform 구조 설계서

기준: GitHub용 소스 트리 `logplus-platform/`  
운영 기준 경로: `/app/logplus-platform`

이 문서는 운영 원본의 `STRUCTURE.md`를 기준으로, 공개 저장소에 포함할 수 있는 소스 구조와 실제 운영 배치를 구분해 재구성했다. 내부 주소, 실제 자격증명, 로그·DB·사용자 작업본은 기록하지 않는다.

## 1. 시스템 전체상

LogPlus는 사내 Git push를 받아 사용자 프로젝트를 Docker로 빌드·실행하고, 생성된 로그를 FastAPI와 웹 대시보드에서 조회·AI 분석하는 파이프라인이다.

```text
개발자 ── git push ──> Nginx / Git HTTP ── 인증 ──> FastAPI
                                             │
                                             └─ post-receive ──> builder
                                                                     │
브라우저 ── React/Vite ── REST ───────────────> FastAPI <── 로그 등록 ┘
                                                                     │
                                                          Docker build/run

FastAPI ──> MariaDB (메타데이터) / 로그 파일 (본문) / Ollama (AI 분석)
```

| 레이어 | GitHub 소스 위치 | 운영 역할 |
| --- | --- | --- |
| 표현 | `apps/web/` | React/Vite 대시보드 |
| 응용 | `apps/api/` | FastAPI, 인증·로그·AI API |
| 자동화 | `services/builder/` | Git hook 이후 프로젝트 동기화·Docker 빌드·로그 등록 |
| 인프라 | `infra/` | Nginx, systemd, n8n 배포 템플릿 |
| 예제 | `examples/python-testpro/` | 파이프라인 검증용 Python 샘플 |
| 문서 | `docs/` | 구조·저장소 경계·운영 참고 |

## 2. GitHub 저장소 트리

```text
logplus-platform/
├── apps/
│   ├── api/                  FastAPI API
│   │   ├── main.py           앱 조립, /health, /logs
│   │   ├── CreateUser.py     사용자·bare repository 생성
│   │   ├── LoginUser.py      로그인
│   │   ├── SelectLogs.py     로그 조회
│   │   ├── Aireanalyze.py    Ollama 기반 분석
│   │   ├── GitAuth.py        Git HTTP 인증 위임
│   │   ├── database.py       DATABASE_URL 환경변수 기반 SQLAlchemy 모델
│   │   ├── requirements.txt  Python 의존성
│   │   └── .env.example      API 환경변수 예시
│   └── web/                  React 19 / Vite / TypeScript SPA
│       ├── src/              화면·상태·API URL 설정
│       ├── package.json      프런트 의존성
│       ├── .nvmrc            Node 22.23.1 기준
│       └── .env.example      VITE_API_BASE_URL 예시
├── services/
│   └── builder/              build.sh: Git checkout → Docker build/run → 로그 등록
├── infra/
│   ├── nginx/                Git HTTP reverse proxy 템플릿
│   ├── systemd/              logplus-api 사용자 서비스 템플릿
│   └── n8n/                  비밀값 없는 Compose 및 .env.example
├── docs/
│   ├── STRUCTURE.md          이 문서
│   └── REPOSITORY_BOUNDARY.md 포함/제외 경계
├── examples/
│   └── python-testpro/       Python 3.11 Docker 실행 샘플
├── .gitignore
└── README.md
```

## 3. 운영 원본에서의 매핑

| 운영 기준 `/app/logplus-platform` | GitHub 소스 | 포함 여부 |
| --- | --- | --- |
| `ReactProject/` | `apps/web/` | 포함, `node_modules` 제외 |
| `api/` | `apps/api/` | 포함, 로그·PID·캐시 제외 |
| `builder/` | `services/builder/` | 포함, 로그·백업·에디터 swap 제외 |
| `deploy/nginx`, `deploy/systemd` | `infra/nginx`, `infra/systemd` | 포함 |
| `docker/n8n` | `infra/n8n` | Compose 예시만 포함 |
| `testpro/` | `examples/python-testpro/` | 포함 |
| `note/`, 기존 구조 문서 | `docs/` | 공개 가능한 문서만 포함 |
| `logs/`, `projects/`, `runtime/` | 운영 데이터·도구 설치물 | 제외 |
| `.git`, 로컬 에이전트 설정 | 로컬 이력·개인 환경 | 제외 |

`/repos`의 bare Git 저장소, MariaDB 데이터, Docker 이미지·볼륨도 운영 데이터이며 이 저장소에 포함하지 않는다.

## 4. 주요 흐름

```text
1. 브라우저 → apps/web → apps/api
   로그인, 로그 목록/본문 조회, AI 재분석 요청

2. 개발자 → Nginx Git HTTP → apps/api/GitAuth.py
   Basic 인증과 팀·사용자 저장소 권한 확인

3. Git post-receive → services/builder/build.sh
   bare repository를 운영 작업본으로 동기화
   Dockerfile 확인 또는 생성 → docker build/run

4. builder → apps/api POST /logs
   LIB/RUN 로그의 운영 파일 경로를 MariaDB에 등록

5. apps/api → Ollama
   로그의 오류·경고를 추출해 한국어 분석 결과 생성
```

## 5. 설정과 비밀값 경계

| 항목 | 공개 저장소 방식 |
| --- | --- |
| API DB 연결 | `apps/api/.env.example`의 `DATABASE_URL` |
| Ollama URL·모델 | API 환경변수 `OLLAMA_URL`, `OLLAMA_MODEL` |
| 웹 API 주소 | `apps/web/.env.example`의 `VITE_API_BASE_URL` |
| n8n DB·호스트 설정 | `infra/n8n/.env.example` |
| Nginx/systemd | `infra/`의 배포 템플릿 |

실제 `.env` 파일과 자격증명은 절대 커밋하지 않는다. 원본 운영 경로의 DB 연결 정보와 n8n 비밀값은 이 저장소에 복사하지 않았다.

## 6. 운영 배치 주의

현재 운영 스크립트와 systemd/Git hook은 `/app/logplus-platform` 경로를 사용한다. 실행 로그는 `/app/logplus-platform/logs` 아래에 저장하고, 프로젝트 작업본은 `/app/logplus-platform/projects` 아래에 둔다.

- API systemd `WorkingDirectory`와 `ExecStart`
- post-receive hook의 builder 호출 경로
- builder의 작업본·로그·런타임 경로
- Nginx와 n8n 배포 파일의 참조

따라서 로그·작업본·런타임 데이터는 Git에 포함하지 않고, 배포 시 해당 디렉터리를 별도로 생성한다.

## 7. 현재 진행 상태

- [x] 운영 기준 경로 `/app/logplus-platform` 정리
- [x] GitHub용 분리 트리 생성
- [x] 의존성·로그·작업본·런타임·기존 Git 이력 제외
- [x] DB/n8n 실제 비밀값을 환경변수 예시로 대체
- [x] 프런트 API 주소를 환경변수 기반으로 전환
- [x] 이 구조 문서 추가
- [ ] 새 저장소 Git 초기화
- [ ] 원격 GitHub 저장소 연결 및 첫 push
- [ ] CI와 운영 배포 절차 확정
