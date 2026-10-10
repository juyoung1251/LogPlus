# Colab API 전환 코드 검증

확인일: 2026-10-04. 대상: `apps/api/Aireanalyze.py`와 사용자가 보관한 `Aireanalyze.py_bak`.

## 결과

현재 코드의 문법과 13개 격리 회귀 테스트가 통과했다. 애플리케이션 코드와 백업을 수정하지 않았으며 테스트 전후 두 파일의 SHA-256이 동일했다. 실제 운영 DB·로그·외부 추론 API에 접근하지 않았고 서비스 재시작과 패키지 설치도 하지 않았다.

함수 AST 비교에서 로그 읽기·전처리, 한국어 재작성 프롬프트, 분석 경로 검증·정리·저장, 이력·다운로드와 입력 모델은 백업과 동일하다. 변경된 함수는 `_ollama_chat`, `_call_ollama`(재작성 안내 로그 추가), `reanalyze`다. 모델 기본값 및 환경변수 설정도 변경되었다.

기존 웹 `apps/web/src/pages/Index.tsx`는 `status`, `message`, `analysis`, `analysis_text`를 사용한다. 이 응답 필드는 유지되며 추가된 `ai_elapsed_seconds`는 기존 화면 계약에 영향을 주지 않는다. 화면에 소요 시간을 표시하는 구현은 없다.

## 기존 동작에 영향을 주는 설정

- 이전 기본 URL은 지정된 외부 Ollama 주소였으나 새 기본값은 빈 문자열이다. `OLLAMA_URL`을 실행 프로세스에 전달하지 않으면 새 분석이 실패한다. 과거 이력·다운로드는 모델을 호출하지 않는다.
- 기본 모델은 `qwen2.5-coder:7b`에서 `qwen3:4b-instruct-2507-q4_K_M`으로 바뀌었다. 외부 서버에 존재하는 정확한 모델명과 일치해야 한다. 모델 품질·속도는 이번 테스트로 검증하지 않았다.
- 현재 `apps/api/start.sh`와 저장소의 systemd 템플릿은 `.env`를 자동 로딩하지 않는다. `.env.example`도 이전 모델 예시다. 파일에 값을 적는 것만으로 실행 프로세스에 반영되지 않는다. 수동 시작은 환경변수 export 후 스크립트 실행, systemd는 서비스의 Environment/EnvironmentFile 설정이 필요하다. 실제 서비스 설정은 조회하지 않았다.
- 연결/읽기 timeout 기본값 10/120초는 정상이다. 잘못된 숫자 환경변수는 import 실패를 일으킬 수 있으므로 유효한 양수를 사용해야 한다.
- 읽기 timeout은 전체 처리의 절대 제한 시간이 아니다. 한국어 재작성은 두 번째 요청이며 합계가 120초를 넘을 수 있다. `ai_elapsed_seconds`는 전처리·DB/파일 저장 시간을 제외한다.
- Bearer 헤더는 Colab 앞단에서 실제 검증해야 인증으로 동작한다. 호출측에서 키를 넣는 것만으로 상대 서버의 인증이 활성화되지 않는다.

## 실행한 검증

설치 Requests 2.25.1, FastAPI 0.128.8, SQLAlchemy 2.0.49, Pydantic 2.13.5, Uvicorn 0.39.0 확인. Context7 Requests 공식 문서 조회에는 버전 전용 ID가 없어 사용자에게 안내하고 실제 Requests 2.25.1로 테스트했다.

명령: `python3 /tmp/logplus-ai-colab-review.py` — 13개 테스트 통과.

- 백업과 저장·조회·전처리 함수의 동일성
- HTTP 요청 필드, Bearer 헤더, 연결/읽기 timeout 전달
- 인증 미설정 시 헤더 생략과 정상 호출 시간 로그의 본문/키 비노출
- URL 누락, HTTP 401/404/503, 연결·읽기 timeout·연결 오류 시 저장하지 않음
- JSON 파싱 실패, 누락/잘못된 choices·message·content, 빈 답변 처리
- 정상 분석 파일 저장과 기존 파일 보존
- 한국어 재작성 두 번째 호출과 정상 응답
- 모델 URL 없이 기존 이력 조회·다운로드 함수 동작
- 분석 디렉터리 외부 파일 거부, 파일 쓰기 실패 시 rollback
- 실제 FastAPI ASGI 요청의 HTTP 200·JSON 응답 계약

첫 실행은 TestClient에 필요한 `httpx`가 없어 테스트 시작 전 실패했다. 의존성을 추가하지 않고 FastAPI ASGI를 직접 호출하도록 테스트 도구를 바꾼 뒤 통과했다. DB는 가짜 세션, 외부 HTTP는 mock, 파일 쓰기는 임시 디렉터리를 사용했다. DB 트랜잭션·운영 다운로드의 종단간 검증을 의미하지 않는다. 테스트 도구는 `/tmp`에 있어 삭제될 수 있다.

## 다음 순서

1. Colab에서 Ollama 또는 호환 API 서버를 실행하고 LogPlus에서 접근할 수 있는 주소를 확인한다. 노트북 URL이나 LogPlus의 127.0.0.1은 외부 Colab API 주소가 아니다.
2. Colab 서버의 정확한 모델명과 응답 형식 `choices[0].message.content`를 확인한다. Transformers 셀 추론만 실행하면 외부 API가 자동 생성되지 않는다.
3. 현재 백엔드 실행 방식에 맞게 URL·모델·필요한 키·timeout을 전달하고 백엔드를 재시작한다. 이번 검증에서는 설정이나 실행 방식을 변경하지 않았다.
4. 익명 예제 1건으로 연결 확인 후 테스트 로그의 웹 분석·이력·다운로드를 확인한다.
5. 동시 1→2→3 요청을 실제로 측정해 품질·지연·GPU 메모리를 비교한다. 이번 격리 테스트는 동시 처리 성능을 보장하지 않는다.

공식 참고: [Requests timeout](https://requests.readthedocs.io/en/latest/user/advanced/#timeouts), [Requests JSON 응답](https://requests.readthedocs.io/en/latest/user/quickstart/#json-response-content).
