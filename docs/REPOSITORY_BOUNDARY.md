# Repository boundary

이 저장소에는 재현 가능한 소스와 배포 템플릿만 둡니다.

포함하지 않는 항목:

- `node_modules`, Node 런타임, Python 캐시
- API/빌더 로그, PID 파일, 사용자 프로젝트 checkout
- `/repos`의 bare Git 저장소와 Docker 이미지·볼륨
- MariaDB 데이터 및 실제 환경변수 파일
- 기존 Git 이력과 로컬 에이전트·에디터 설정

운영 데이터는 별도 백업 정책으로 관리합니다.
