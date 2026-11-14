# AI 재분석 현재 상태 (apps/api/Aireanalyze.py)

> 작성일: 2026-11-07 · 기준: `main` 작업 트리 (HEAD `58c3b4c`)
> 이전 분석 문서: `docs/AI_PREPROCESS.md` (2026-10-31)

---

## 0. 결론 요약: 전처리 로직은 바뀌지 않았다

"최근 수정되었다"는 전제와 달리, **`Aireanalyze.py`의 전처리 로직은 기존 Java 중심 6개 패턴 그대로다.**

| 확인 항목 | 결과 |
|---|---|
| 작업 트리 변경 | 없음 (`git status`에 `Aireanalyze.py` 미표시) |
| 파일 수정 시각 (mtime) | 2026-10-04 02:43 |
| 이 파일을 마지막으로 바꾼 커밋 | `828eec3` (2026-10-10) |
| `_preprocess_log()` vs `Aireanalyze.py_bak_ollama` | **완전히 동일** (함수 본문 diff 결과 차이 없음) |
| 백업과의 차이 | 128줄. 모두 Colab API 설정(`OLLAMA_API_KEY`, 타임아웃), `_korean_ratio` 개선, 호출 시간 로깅 등이며 전처리와는 무관 |

| 요청 항목 | 존재 여부 |
|---|---|
| `_preprocess_log()` | ✅ 그대로 존재 (77–213행) |
| "근거 선택" / "핵심 추출" 신규 함수 | ❌ 없음. `_preprocess_log()` 내부 함수 `clip` / `signature` / `event_block`만 있음 |
| 분할·통합(map-reduce) 함수 | ❌ 없음 |
| 로그 크기별 분기 | ❌ 없음. 크기는 **로깅용으로만** 계산함 |
| 청크 분할 | ❌ 없음 (`chunk`/`청크` 문자열이 `apps/api` 코드에 없음) |
| Python / C/C++ 에러 패턴 | ❌ 없음. `panic`(Go/Rust)과 `SIGKILL`/`SIGTERM`만 일부 언어 중립 |

> 변경 작업이 다른 브랜치나 다른 경로(예: 다른 서버, 커밋 안 된 다른 클론)에 있을 수 있다.
> 현재 `/app/logplus-platform` 작업 트리에는 반영되어 있지 않다.

---

## 1. `_preprocess_log()` 현재 코드 전체

`apps/api/Aireanalyze.py:77-213`

```python
def _preprocess_log(log_content: str) -> str:
    """컨텍스트를 넘기지 않으면서 실제 장애의 대표 근거를 보존한다.

    기존 방식은 오류 라인을 모두 모은 뒤 마지막 부분만 잘라서,
    앞쪽에 있던 ConnectException 같은 근본 원인이 사라질 수 있었다.
    오류 종류별로 대표 라인과 짧은 앞뒤 문맥을 남긴다.
    """
    lines = log_content.splitlines()
    if not lines:
        return ""

    # 각 예외 종류에 별도 예산을 줘서 한 종류의 긴 스택트레이스가
    # 다른 핵심 오류를 밀어내지 않게 한다. 합계는 6000자 이내다.
    rules = [
        (
            "연결 실패",
            re.compile(
                r"ConnectException|SocketException|TimeoutException|"
                r"Connection refused|ADT_\d+",
                re.IGNORECASE,
            ),
            2,
            1100,
        ),
        (
            "메시지 구조 불일치",
            re.compile(
                r"UnmarshallException|cannot find structureField|field named",
                re.IGNORECASE,
            ),
            2,
            1300,
        ),
        (
            "JSON 문법 오류",
            re.compile(
                r"JsonParseException|JSON parse|unexpected character|"
                r"unexpected end",
                re.IGNORECASE,
            ),
            1,
            850,
        ),
        (
            "거래 실패 응답",
            re.compile(r"HTTP/1\.[01] [45]\d\d", re.IGNORECASE),
            1,
            850,
        ),
        (
            "오류 처리 미설정",
            re.compile(r"error handle is not set|handler.*not set", re.IGNORECASE),
            1,
            650,
        ),
        (
            "런타임 치명 오류",
            re.compile(
                r"NoClassDefFoundError|ClassNotFoundException|"
                r"UnsupportedClassVersionError|OutOfMemoryError|"
                r"SIGKILL|SIGTERM|killed process|panic",
                re.IGNORECASE,
            ),
            1,
            850,
        ),
    ]

    def clip(text: str, limit: int) -> str:
        text = text.strip()
        return text if len(text) <= limit else text[:limit] + " ...[생략]"

    def signature(label: str, line: str) -> str:
        lower = line.lower()
        if label == "메시지 구조 불일치":
            field = re.search(r"field named,?\s*([a-z0-9_]+)", lower)
            return f"{label}:{field.group(1)}" if field else label
        if label == "연결 실패":
            for key in ("adt_", "connectexception", "socketexception", "timeoutexception"):
                if key in lower:
                    return f"{label}:{key}"
        normalized = re.sub(r"\b[0-9a-f]{8,}\b|\b\d+\b", "<N>", lower)
        return f"{label}:{normalized[:180]}"

    def event_block(index: int, budget: int) -> str:
        block = [f"대표 오류 L{index + 1}: {clip(lines[index], 520)}"]
        context_indexes = (
            list(range(max(0, index - 2), index))
            + list(range(index + 1, min(len(lines), index + 4)))
        )
        if context_indexes:
            block.append("문맥:")
            block.extend(f"L{i + 1}: {clip(lines[i], 130)}" for i in context_indexes)
        return "\n".join(block)[:budget]

    sections = []
    for label, pattern, max_events, char_budget in rules:
        events = []
        seen = set()
        event_budget = max(1, char_budget // max_events)

        for index, line in enumerate(lines):
            if not pattern.search(line):
                continue
            event_signature = signature(label, line)
            if event_signature in seen:
                continue
            seen.add(event_signature)
            events.append(event_block(index, event_budget))
            if len(events) >= max_events:
                break

        if events:
            sections.append(f"[{label}]\n" + "\n---\n".join(events))

    if sections:
        return "\n\n".join(sections)[:MAX_LOG_CHARS]

    # 핵심 패턴이 없을 때만 일반 오류를 보조 정보로 사용한다.
    shutdown_pattern = re.compile(
        r"shutdown|shutting down|graceful shutdown|"
        r"thread stopping as it is now interrupted",
        re.IGNORECASE,
    )
    fallback = []
    for index, line in enumerate(lines):
        if shutdown_pattern.search(line):
            continue
        if re.search(r"\|(CRITICAL|FATAL|SEVERE)\||\bERROR\b", line, re.IGNORECASE):
            fallback.append(f"L{index + 1}: {clip(line, 420)}")
            if len(fallback) >= 40:
                break

    if fallback:
        return "\n".join(fallback)[:MAX_LOG_CHARS]

    return "\n".join(lines[-40:])[:MAX_LOG_CHARS]
```

### 내부 보조 함수 (신규 아님)

| 함수 | 역할 |
|---|---|
| `clip(text, limit)` | 앞뒤 공백 제거 후 `limit`자 초과분을 `...[생략]`으로 자름 |
| `signature(label, line)` | 중복 판정 키. 구조 불일치는 필드명, 연결 실패는 예외 종류별, 나머지는 숫자·16진수 ID를 `<N>`으로 정규화 |
| `event_block(index, budget)` | 대표 라인(최대 520자) + 앞 2줄/뒤 3줄 문맥(줄당 130자)을 묶어 이벤트당 예산으로 자름 |

---

## 2. 새로 추가된 함수

**없다.** 모듈 수준 함수 목록은 다음이 전부이며, 모두 기존부터 있던 것이다.

| 함수 | 행 | 역할 |
|---|---|---|
| `_read_log_content` | 49 | DB에서 `log_path` 조회 후 파일 전체 읽기 |
| `_preprocess_log` | 77 | 핵심 라인 추출 (최대 6,000자) |
| `_korean_ratio` | 216 | 응답의 한국어 비율 계산 (코드·식별자 제외) |
| `_ollama_chat` | 236 | OpenAI 호환 `/v1/chat/completions` 호출 |
| `_rewrite_in_korean` | 280 | 한국어 비율이 낮을 때 2차 재작성 호출 |
| `_call_ollama` | 311 | system/user 프롬프트 조립 → `_ollama_chat` |
| `_analysis_dir` / `_analysis_query` / `_resolve_analysis_file` / `_prune_analyses` / `_save_analysis` | 377–466 | 분석 결과 저장·조회·정리 |
| `reanalyze` / `ai_history` / `download_analysis` | 468 / 535 / 586 | 라우터 엔드포인트 |

"근거 선택", "핵심 추출", 청크 분할, 부분 결과 통합(merge/reduce)에 해당하는 함수는 없다.

---

## 3. 큰 로그 처리 로직

- **크기별 분기 없음.** 원본 파일 크기는 `reanalyze()`에서 **로그 출력용으로만** 계산한다.
- **청크 분할 없음.** 로그 크기와 관계없이 `_preprocess_log()`가 단 한 번 실행되고, 결과를 Qwen에 **1회** 보낸다.
- 큰 로그는 다음 방식으로만 줄어든다.
  1. 규칙별 최대 이벤트 수(1~2개)와 문자 예산(650~1,300자)
  2. 각 규칙은 로그를 **처음부터** 훑어 `max_events`개를 찾으면 멈춤 → 뒤쪽 오류는 누락 가능
  3. 최종 결과를 `MAX_LOG_CHARS = 6000`자에서 자름
  4. 패턴이 하나도 안 걸리면 `ERROR`/`CRITICAL|FATAL|SEVERE` 라인 최대 40줄, 그것도 없으면 마지막 40줄

```python
# apps/api/Aireanalyze.py:476-485 — 크기는 기록만 하고 분기에 쓰지 않는다
try:
    file_bytes = Path(source_log.log_path).stat().st_size
    file_size = f"{file_bytes}바이트 ({file_bytes / 1024:.2f} KiB)"
except OSError:
    file_size = "확인 불가"

print(
    f"AI 분석 입력: build_log_id={userData.build_log_id} "
    f"원본 파일={file_size} "
    ...
```

---

## 4. 에러 패턴 규칙

### 핵심 규칙 6개 (모두 `re.IGNORECASE`)

| # | 라벨 | 정규식 | 최대 이벤트 | 문자 예산 |
|---|---|---|---|---|
| 1 | 연결 실패 | `ConnectException\|SocketException\|TimeoutException\|Connection refused\|ADT_\d+` | 2 | 1,100 |
| 2 | 메시지 구조 불일치 | `UnmarshallException\|cannot find structureField\|field named` | 2 | 1,300 |
| 3 | JSON 문법 오류 | `JsonParseException\|JSON parse\|unexpected character\|unexpected end` | 1 | 850 |
| 4 | 거래 실패 응답 | `HTTP/1\.[01] [45]\d\d` | 1 | 850 |
| 5 | 오류 처리 미설정 | `error handle is not set\|handler.*not set` | 1 | 650 |
| 6 | 런타임 치명 오류 | `NoClassDefFoundError\|ClassNotFoundException\|UnsupportedClassVersionError\|OutOfMemoryError\|SIGKILL\|SIGTERM\|killed process\|panic` | 1 | 850 |

### 보조(fallback) 패턴 — 핵심 규칙이 하나도 안 걸릴 때만

- 포함: `\|(CRITICAL|FATAL|SEVERE)\|` 또는 `\bERROR\b`
- 제외: `shutdown|shutting down|graceful shutdown|thread stopping as it is now interrupted`

### 언어별 커버리지

| 언어 | 상태 |
|---|---|
| Java | 대부분의 규칙이 Java 예외명 기반 |
| Python (`Traceback`, `ModuleNotFoundError`, `KeyError` 등) | ❌ 전용 패턴 없음. `ERROR` 단어가 있을 때만 fallback으로 잡힘 |
| C/C++ (`Segmentation fault`, `core dumped`, `SIGSEGV`, `undefined reference` 등) | ❌ 전용 패턴 없음 |
| 공통 | `SIGKILL`, `SIGTERM`, `killed process`, `panic`, HTTP 4xx/5xx 정도 |

---

## 5. 모델과 설정

```python
# apps/api/Aireanalyze.py:19-28
OLLAMA_URL = os.getenv("OLLAMA_URL", "").strip()
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b-instruct-2507-q4_K_M")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()
OLLAMA_CONNECT_TIMEOUT = float(os.getenv("OLLAMA_CONNECT_TIMEOUT", "10"))
OLLAMA_READ_TIMEOUT = float(os.getenv("OLLAMA_READ_TIMEOUT", "120"))
MAX_LOG_CHARS = 6000
MAX_OUTPUT_TOKENS = int(os.getenv("OLLAMA_MAX_TOKENS", "1200"))
```

| 항목 | 값 |
|---|---|
| 모델 | `qwen3:4b-instruct-2507-q4_K_M` (코드 기본값 = `logplus-colab.env` 값) |
| `MAX_LOG_CHARS` | `6000` (하드코딩, 환경변수 아님) |
| `MAX_OUTPUT_TOKENS` | `1200` (`OLLAMA_MAX_TOKENS`) |
| 타임아웃 | 연결 10초 / 읽기 120초 |
| 엔드포인트 | `logplus-colab.env`의 `OLLAMA_URL` → Colab의 OpenAI 호환 `.../v1/chat/completions` (Tailscale 주소). 비어 있으면 `RuntimeError` |
| 인증 | `OLLAMA_API_KEY`가 있으면 `Authorization: Bearer ...` |
| 샘플링 | 1차 `temperature=0.2`, 재작성 `0.1`, `top_p=0.8`, `stream=False` |
| 앱 엔드포인트 | `POST /ai/reanalyze`, `POST /ai/history`, `GET /ai/download` |

---

## 6. 호출 흐름

질문의 "전처리 → 청크 분할 → Qwen 호출 → 통합" 순서는 **현재 코드와 맞지 않다.** 청크 분할과 통합 단계가 없다.

```
POST /ai/reanalyze  {users_id, team_id, build_log_id}
  │
  ├─ 1. _read_log_content()     LogTable에서 log_path 조회 → 파일 전체 UTF-8 읽기
  │                              (실패 시 {"status":"fail"} 반환)
  ├─ 2. _preprocess_log()       6개 규칙 → fallback → 마지막 40줄, 최대 6,000자
  ├─ 3. 원본 크기/전처리 길이 로그 출력 (분기 없음)
  ├─ 4. _call_ollama()          system + user 프롬프트 조립
  │      └─ _ollama_chat()      Qwen 1회 호출
  │      └─ _korean_ratio() < 0.35 이면 _rewrite_in_korean() 으로 2차 호출
  ├─ 5. 응답을 줄 단위 리스트(analysis)로 변환
  └─ 6. _save_analysis()        logs/{team_id}/{users_id}/analyses/ 에 저장 + DB 기록
                                 → _prune_analyses() (ANALYSIS_KEEP_PER_LOG > 0일 때)
```

```python
# apps/api/Aireanalyze.py:468-490 (요약)
@router.post("/ai/reanalyze")
def reanalyze(userData: ReanalyzeInput, db: Session = Depends(get_db)):
    source_log, log_content, error_message = _read_log_content(...)
    if error_message:
        return {"status": "fail", "message": error_message}

    # 핵심 라인만 추려서 분석 (속도/정확도 향상)
    analysis_target = _preprocess_log(log_content)
    ...
    analysis_text = _call_ollama(analysis_target)
```

---

## 7. 변경 전(기존 Java 중심 6개 패턴) 대비 변경 사항

| 영역 | 기존 | 현재 | 변경 |
|---|---|---|---|
| `_preprocess_log()` | 6개 규칙 + fallback | 동일 | **없음** |
| 에러 패턴 | Java 중심 6개 | 동일 | **없음** |
| Python / C/C++ 패턴 | 없음 | 없음 | **없음** |
| 근거 선택 / 핵심 추출 함수 | 없음 | 없음 | **없음** |
| 크기별 분기 / 청크 분할 / 통합 | 없음 | 없음 | **없음** |
| `MAX_LOG_CHARS` | 6000 | 6000 | **없음** |
| 모델 | `qwen3:4b-instruct-2507-q4_K_M` | 동일 | **없음** |

`Aireanalyze.py_bak_ollama`(2026-10-04 01:26) 대비 현재 파일에서 바뀐 것은 전처리 **밖**의 부분뿐이다.

- Colab API 연동: `OLLAMA_API_KEY` Bearer 인증, `OLLAMA_CONNECT_TIMEOUT` / `OLLAMA_READ_TIMEOUT`
- `_korean_ratio()`: 코드 블록·인용·기술 식별자를 제외하고 한국어 비율을 판정 (`LOGPLUS_LATENCY_PATCH_V1`)
- `_ollama_chat()`: 토큰 사용량, 종료 사유, 호출 시간 로깅
- `reanalyze()`: 원본 파일 크기/전처리 길이 로깅, `ai_elapsed_seconds` 응답 필드

### 다음에 적용하려던 변경이 있다면

"근거 선택 + 청크 분할 + 통합", Python/C/C++ 패턴 추가는 아직 구현되지 않았다.
다른 브랜치나 서버에 작업본이 있는지 확인이 필요하다.
참고로 `train_logplus.sh`는 `Aireanalyze.py`를 AST로 파싱해 `_preprocess_log`와 프롬프트를 그대로 재사용하므로,
전처리를 바꾸면 학습 데이터 생성에도 같이 반영된다 (`docs/AI_PREPROCESS.md` 참고).
