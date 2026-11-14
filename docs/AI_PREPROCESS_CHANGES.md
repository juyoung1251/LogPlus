# `_preprocess_log()` 개선 내역

> 작성일: 2026-11-07 · 대상: `apps/api/Aireanalyze.py` `_preprocess_log()` (77–473행)
> 이전 상태: `docs/AI_CURRENT_STATE.md`, `docs/AI_PREPROCESS.md`
> 변경 전 원본 백업: `git show HEAD:apps/api/Aireanalyze.py`

---

## 요약

| # | 변경 | 핵심 |
|---|---|---|
| 1 | 규칙 6개 → **17개** | Java 6개는 그대로 두고 Python 4개, C/C++ 3개, 빌드 도구 4개를 추가 |
| 2 | **Python Traceback 블록 추출** | `_extract_python_traceback()`가 규칙보다 먼저 실행됨. 같은 예외는 묶어서 횟수를 셈 |
| 3 | **발생 횟수 집계** | `seen`을 `set`에서 `dict`로 바꿈. 대표 라인에 `(총 N회 발생)`을 붙이고, 생략한 유형도 집계해 표시 |
| 4 | **범주 간 중복 제거** | 범주 사이에서 공유하는 `global_seen`(이미 집계한 라인)과 `printed`(이미 출력한 라인) |
| 5 | **폴백 보완** | WARN/WARNING/Error/Exception/FAILED/FAILURE 추가, 40줄 → 60줄, 빌드 종료 메시지 섹션 추가 |
| – | 전체 예산 관리 | 섹션을 우선순위대로 넣으면서 남은 예산(`remaining`)을 추적함. 마지막에 6000자로 한 번 더 자름 |

유지한 것은 다음과 같습니다.
- Java 규칙 6개 (정규식, 이벤트 수, 예산 모두 그대로)
- `MAX_LOG_CHARS = 6000`
- 함수 시그니처 `_preprocess_log(log_content: str) -> str`
- 헬퍼 `clip` / `signature` (코드 그대로), `event_block` (인자만 확장)

### train_logplus.sh 호환성 (중요)

`train_logplus.sh`의 `load_prompt_tools()`는 **`_preprocess_log` 함수 노드 하나만** AST로 떼어 `{"re": re, "MAX_LOG_CHARS": limit}` 네임스페이스에서 실행합니다.
그래서 `_extract_python_traceback()`을 모듈 수준에 두면 학습 데이터를 만들 때 `NameError`가 납니다.
**이 함수는 `_preprocess_log()` 안의 내부 함수로 정의했습니다** (`clip`, `signature`와 같은 방식). 추가 import는 없습니다.
테스트도 학습 스크립트와 같은 격리 방식으로 실행해 동작을 확인했습니다.

> 전처리 결과가 바뀌므로 다음 학습 후보(`candidates.jsonl`)의 입력 형식과 소스 해시도 바뀝니다.
> 이전 학습 데이터와 섞어 쓸 경우 이 점을 감안해야 합니다.

---

## 1. 규칙 추가 (Python / C/C++ / 빌드 도구)

### 변경 전

```python
rules = [
    ("연결 실패", re.compile(r"ConnectException|...|ADT_\d+", re.IGNORECASE), 2, 1100),
    ("메시지 구조 불일치", ..., 2, 1300),
    ("JSON 문법 오류", ..., 1, 850),
    ("거래 실패 응답", ..., 1, 850),
    ("오류 처리 미설정", ..., 1, 650),
    ("런타임 치명 오류", ..., 1, 850),
]
```

### 변경 후 (Java 6개 뒤에 추가)

```python
        # ---- Python ----
        ("Python 모듈 오류",
         re.compile(r"\b(?:ModuleNotFoundError|ImportError)\b|No module named", re.IGNORECASE), 2, 900),
        ("Python 문법 오류",
         re.compile(r"\b(?:SyntaxError|IndentationError|TabError)\b", re.IGNORECASE), 1, 750),
        ("Python 런타임 오류",
         re.compile(r"\b(?:NameError|AttributeError|TypeError|ValueError|"
                    r"KeyError|IndexError)\b", re.IGNORECASE), 2, 1000),
        ("Python 파일 오류",
         re.compile(r"\b(?:FileNotFoundError|PermissionError|IsADirectoryError)\b", re.IGNORECASE), 1, 650),
        # ---- C/C++ ----
        ("C/C++ 컴파일 오류",
         re.compile(r"\.(?:c|cc|cpp|cxx|h|hpp)(?::\d+){1,2}:\s*(?:fatal\s+)?error:", re.IGNORECASE), 2, 1000),
        ("C/C++ 링커 오류",
         re.compile(r"undefined reference to|cannot find -l\S*|ld returned", re.IGNORECASE), 2, 900),
        ("C/C++ 치명 오류",
         re.compile(r"fatal error:|segmentation fault|core dumped", re.IGNORECASE), 1, 750),
        # ---- 빌드 도구 ----
        ("Maven 빌드 실패",
         re.compile(r"BUILD FAILURE|COMPILATION ERROR", re.IGNORECASE), 2, 700),
        ("pip 설치 실패",
         re.compile(r"Could not find a version|No matching distribution", re.IGNORECASE), 1, 600),
        ("make 빌드 실패",
         re.compile(r"make(?:\[\d+\])?: \*\*\* .*Error|recipe for target .* failed", re.IGNORECASE), 1, 600),
        ("비정상 종료 코드",
         re.compile(r"exit (?:code|status)[:=]?\s*[1-9]\d*", re.IGNORECASE), 1, 450),
```

요청 사양과 다르게 정한 부분은 다음과 같습니다.

| 항목 | 결정 | 이유 |
|---|---|---|
| Python 예외명 | `\b` 단어 경계를 붙임 | `MyKeyErrorHandler` 같은 식별자가 잘못 매칭되는 것을 줄임 |
| C/C++ 확장자 | `.c/.cpp/.h`에 `.cc/.cxx/.hpp`도 추가 | 같은 gcc/clang 형식이라 비용이 없음. `file.c:12:` 형식과 `file.c:12:5:` 형식 모두 허용 |
| 종료 코드 | `exit code 1` / `exit status 1` → **0이 아닌 모든 코드** (`[1-9]\d*`) | `exit code 2`, `exit status 137`(OOM kill)도 실패라서 포함. `exit code 0`은 제외 |
| Maven | 이벤트 1개 → **2개 / 700자** | 테스트해 보니 `COMPILATION ERROR`가 먼저 나와 `BUILD FAILURE`가 가려졌음 |
| 우선순위 | Java → Python → C/C++ → 빌드 | 예산이 모자라면 뒤쪽 범주부터 잘림. 빌드 도구 메시지는 정보량이 가장 적어서 마지막에 둠 |

---

## 2. Python Traceback 블록 추출

### 변경 전

없었습니다. Traceback의 `KeyError: 'db'` 라인은 어떤 규칙에도 걸리지 않았습니다.
`ERROR`라는 단어도 없으면 폴백에서도 빠져 **마지막 40줄**만 모델에 전달됐습니다.

### 변경 후 (`_preprocess_log` 내부 함수, 299행)

```python
    def _extract_python_traceback(max_blocks: int = 2, budget: int = 1800) -> str:
        """Traceback (most recent call last): 부터 예외 라인까지 블록 단위로 보존한다."""
        found = {}  # 예외 라인 시그니처 -> [시작, 끝, 횟수]
        index = 0
        while index < len(lines):
            if "Traceback (most recent call last)" not in lines[index]:
                index += 1
                continue
            start = index
            limit = min(len(lines), start + 300)
            end = limit - 1
            # 프레임과 코드 줄은 들여쓰기돼 있다. 처음 나오는 들여쓰기 없는 줄이 예외 라인이다.
            for j in range(start + 1, limit):
                text = lines[j]
                if not text.strip() or text[0] in " \t":
                    continue
                end = j
                break
            global_seen.update(range(start, end + 1))
            key = signature("Python Traceback", lines[end])
            ...
```

동작은 다음과 같습니다.
- 블록 범위는 `Traceback (most recent call last):` 라인부터, 처음 나오는 **들여쓰기 없는 줄**(예외 라인)까지입니다. 최대 300줄까지 봅니다.
- 같은 예외 라인(숫자와 ID를 정규화한 시그니처)은 하나로 묶고 `(총 N회 발생)`을 붙입니다.
- 서로 다른 예외는 최대 2종까지 보존합니다. 합계 1,800자, 블록당 900자입니다. 나머지는 `(다른 Traceback K종, 총 M회는 생략)`으로 표시합니다.
- 출력 순서는 **예외 라인 → Traceback 헤더 → 프레임**입니다. 블록이 예산 때문에 잘려도 예외 라인은 남습니다.
- 프레임이 12줄을 넘으면 앞 2줄과 뒤 10줄만 남기고 중간은 `... (중간 N줄 생략)`으로 줄입니다. Python에서는 마지막 프레임이 실제 실패 지점입니다.
- 블록 전체를 `global_seen`에 넣으므로, 같은 `KeyError` 라인을 "Python 런타임 오류" 규칙이 다시 집계하지 않습니다.
- 체인 예외(`During handling of the above exception...`)는 각 Traceback을 별도 블록으로 인식합니다.

알려진 한계가 있습니다. 모든 줄 앞에 타임스탬프가 붙는 로거 형식에서는 프레임이 들여쓰기 없이 기록됩니다.
이 경우 첫 프레임 줄을 예외 라인으로 잘못 인식합니다. 그래도 Python 규칙(4~7번 범주)이 예외 라인을 따로 잡습니다.

---

## 3. 발생 횟수 집계

### 변경 전

```python
        events = []
        seen = set()
        ...
        for index, line in enumerate(lines):
            if not pattern.search(line):
                continue
            event_signature = signature(label, line)
            if event_signature in seen:
                continue          # ← 횟수 정보가 사라짐
            seen.add(event_signature)
            events.append(event_block(index, event_budget))
            if len(events) >= max_events:
                break             # ← 이후 발생은 집계도 안 됨
```

### 변경 후

```python
        seen = {}  # 시그니처 -> 발생 횟수 (삽입 순서 = 최초 발생 순서)
        first_index = {}
        matched = []
        for index, line in enumerate(lines):
            if index in global_seen or not pattern.search(line):
                continue
            event_signature = signature(label, line)
            seen[event_signature] = seen.get(event_signature, 0) + 1
            first_index.setdefault(event_signature, index)
            matched.append(index)
        ...
        for event_signature in signatures[:max_events]:
            index = first_index[event_signature]
            skip = global_seen | printed
            events.append(event_block(index, event_budget, seen[event_signature], skip))
        ...
        if rest:
            body += (f"\n(같은 범주의 다른 유형 {len(rest)}종, "
                     f"총 {sum(seen[s] for s in rest)}회는 생략)")
```

```python
    def event_block(index: int, budget: int, count: int = 1, skip=frozenset()) -> str:
        # 횟수는 첫 줄에 둬서 예산으로 잘려도 남게 한다.
        block = [f"대표 오류 L{index + 1} (총 {count}회 발생): {clip(lines[index], 520)}"]
        context_indexes = [i for i in context_of(index) if i not in skip]
        ...
```

- 이제 `break` 없이 로그 전체를 훑습니다. 대표 이벤트는 기존과 같이 **처음 나온 순서**로 고릅니다. 근본 원인이 보통 앞쪽에 있기 때문입니다.
- `(총 N회 발생)`은 1회일 때도 붙입니다. 모델이 횟수를 추측하지 않게 하려는 것입니다.
- 이벤트 수 한도 때문에 빠진 유형도 `N종, M회`로 존재를 알립니다.

출력 예시:

```
[연결 실패]
대표 오류 L2 (총 30회 발생): 2026|ERROR|java.net.ConnectException: Connection refused id=0
문맥:
L1: 2026|INFO|start
```

변경 전에는 같은 로그에서 `L3: ...ConnectException id=1`, `L4: ...id=2` 같은 중복 라인이 문맥 자리를 차지했고, 횟수 정보는 없었습니다.

---

## 4. 범주 간 중복 제거

### 변경 전

범주마다 `seen = set()`을 새로 만들었습니다. 그래서 한 라인이 A 범주의 대표가 되고, B 범주의 대표가 되고, C 범주의 문맥으로 또 들어갈 수 있었습니다.

### 변경 후

```python
    # global_seen: 어느 범주(또는 Traceback)가 이미 집계한 라인. 다른 범주에서 다시 집계하지 않는다.
    # printed: 문맥으로 이미 출력한 라인. 문맥으로 다시 출력하지 않는다.
    # 문맥으로만 보인 라인은 다른 범주의 대표 오류가 될 수 있다.
    global_seen = set()
    printed = set()
```

| 상황 | 처리 |
|---|---|
| 앞 범주(또는 Traceback)가 이미 **집계**한 라인 | 뒤 범주에서 매칭·집계·출력하지 않음 |
| 이미 **문맥으로 출력**된 라인 | 다른 이벤트의 문맥으로 다시 출력하지 않음 |
| 같은 범주의 중복 발생 라인 | 문맥에서 빠짐 (횟수로만 표현) |
| 앞 범주의 **문맥으로만** 보인 라인이 뒤 범주 규칙에 매칭 | 뒤 범주의 대표 오류로 **허용** (아래 설명) |

#### 요청 사양("한 번 들어간 라인은 재사용 금지")과 다른 점

처음에는 문맥 라인까지 `global_seen`에 넣는 엄격한 방식으로 구현했습니다. 그런데 테스트에서 **기존 Java 동작이 퇴행**했습니다.

```
HTTP/1.1 500 Internal Server Error   ← [거래 실패 응답] 대표
error handle is not set              ← 위 이벤트의 문맥으로 소비되어 [오류 처리 미설정] 섹션이 사라짐
```

같은 문제로 Python 샘플에서는 pip 오류와 종료 코드가, C 샘플에서는 segfault와 make 실패가 앞 이벤트의 문맥에 묻혀 각자의 범주를 잃었습니다.
그래서 "**집계**는 한 범주만, **문맥 출력**은 한 번만" 방식으로 나눴습니다.
대가로 대표 라인 한 줄이 문맥과 대표 자리에 두 번 나올 수 있습니다. 예산 낭비는 줄당 최대 520자이고, 범주 정보가 남는 쪽이 더 낫다고 판단했습니다.

---

## 5. 폴백 보완

### 변경 전

```python
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

### 변경 후

```python
    error_pattern = re.compile(
        r"\|(CRITICAL|FATAL|SEVERE)\||\bERROR\b|\w*(?:Error|Exception)\b|"
        r"\bFAIL(?:ED|URE)\b",
        re.IGNORECASE,
    )
    warning_pattern = re.compile(r"\bWARN(?:ING)?\b", re.IGNORECASE)
    build_end_pattern = re.compile(
        r"BUILD FAIL(?:URE|ED)|Finished:\s*(?:FAILURE|UNSTABLE|ABORTED)|"
        r"exit(?:ed)?\s+(?:with\s+)?(?:code|status)[:=]?\s*[1-9]\d*|"
        r"ERROR: Job failed",
        re.IGNORECASE,
    )

    # 빌드 종료 메시지는 보통 로그 끝에 있으므로 마지막 5개를 따로 보존한다.
    build_end = [i for i, line in enumerate(lines) if build_end_pattern.search(line)][-5:]
    ...
    # 오류를 먼저 채우고, 남는 자리를 경고로 채운다. 합계 최대 60줄.
    picked_errors = list(errors.values())[:60]
    picked_warnings = list(warnings.values())[: 60 - len(picked_errors)]
```

출력 구조:

```
[빌드 종료]
L104: Finished: FAILURE

[오류 라인]
L103 (총 1회 발생): Job FAILED step deploy

[경고 라인]
L101 (총 2회 발생): WARN disk 80%
```

- 매칭 대상을 넓혔습니다. `Error`/`Exception`으로 끝나는 단어(`NullPointerException`, `RuntimeError` 등), `FAILED`/`FAILURE`, `WARN`/`WARNING`을 추가했습니다.
- **오류를 먼저 채우고 경고는 남는 자리에만** 넣습니다. 앞쪽 WARN 라인이 뒤쪽 ERROR를 밀어내지 않게 하려는 것입니다.
- 폴백도 시그니처로 중복을 제거하고 `(총 N회 발생)`을 붙입니다.
- 빌드 종료 감지(`[빌드 종료]`)를 추가했습니다. 대상은 Maven/Gradle `BUILD FAILURE/FAILED`, Jenkins `Finished: FAILURE/UNSTABLE/ABORTED`, `exited with code N`, GitLab `ERROR: Job failed`이고, 마지막 5개를 보존합니다.
- 40줄 → 60줄은 **두 곳 모두** 적용했습니다. 폴백 수집 한도와 "아무것도 없을 때 마지막 N줄"입니다.
- 빌드 종료 라인만 있고 오류/경고 라인이 없으면 `[마지막 60줄]`을 함께 붙여 실패 직전 상황을 보여 줍니다.
- `\|(CRITICAL|FATAL|SEVERE)\|`(파이프로 구분된 레벨)와 shutdown 제외 규칙은 기존 그대로입니다.
- 참고: `BUILD FAILURE`와 `exit code N`은 1번의 규칙에서 먼저 잡힙니다. 폴백의 빌드 종료 감지는 규칙에 없는 형식(Jenkins/GitLab/Gradle)을 위한 것입니다.

---

## 전체 예산 관리 (부수 변경)

### 변경 전

섹션을 모두 만든 뒤 `"\n\n".join(sections)[:MAX_LOG_CHARS]`로 잘랐습니다. 규칙이 6개(합계 5,600자)일 때는 문제가 없었습니다.

### 변경 후

규칙이 17개가 되고 Traceback까지 더하면 예산 합계가 6,000자를 크게 넘습니다. 그래서 섹션을 넣을 때마다 남은 예산을 추적합니다.

```python
    def add_section(text: str) -> None:
        nonlocal remaining
        separator = 2 if sections else 0
        room = remaining - separator
        if room < 120:
            return
        piece = text if len(text) <= room else text[:room]
        sections.append(piece)
        remaining -= separator + len(piece)
```

우선순위(Traceback → Java → Python → C/C++ → 빌드)대로 채우고, 남은 공간이 120자 미만이면 뒤 섹션은 넣지 않습니다.
마지막 `[:MAX_LOG_CHARS]`는 안전장치로 남겨 두었습니다.

---

## 검증 결과

모든 테스트는 `train_logplus.sh`와 같은 방식으로 실행했습니다. `_preprocess_log` 노드만 AST로 떼어 `{re, MAX_LOG_CHARS}` 네임스페이스에서 실행합니다.

### 합성 샘플 (변경 전 → 변경 후, 전처리 결과 문자 수)

| 샘플 | 변경 전 | 변경 후 | 변경 후 섹션 |
|---|---|---|---|
| Python (Traceback 3개, pip, ValueError, exit code) | 150자 (폴백 2줄) | 867자 | Python Traceback(KeyError ×2, ModuleNotFoundError), Python 런타임 오류, pip 설치 실패, 비정상 종료 코드 |
| C/make (컴파일, 링커, segfault) | 290자 (폴백) | 742자 | C/C++ 컴파일 오류, 링커 오류, 치명 오류, make 빌드 실패 |
| Maven | 165자 (폴백) | 273자 | Maven 빌드 실패 (COMPILATION ERROR, BUILD FAILURE) |
| Java (ConnectException ×30, HTTP 500, handler) | 580자 | 337자 | 기존 3개 범주 그대로, `총 30회 발생` 추가, 중복 문맥 제거 |
| 폴백 (WARN, FAILED, Jenkins FAILURE) | 320자 (마지막 40줄) | 118자 | 빌드 종료, 오류 라인, 경고 라인 |
| 모든 범주가 동시에 매칭되는 최악의 경우 | – | 6,000자 | 우선순위 순으로 9개 섹션까지 채운 뒤 예산 소진 |
| 1.4MB 혼합 로그 | 882자 | 2,397자 | 처리 시간 1초 미만 |

변경 전에는 Python/C/Maven 로그에서 Java 규칙이 하나도 걸리지 않았습니다. 그래서 폴백의 `ERROR` 라인 몇 줄만 남았습니다.
특히 `KeyError: 'db'`처럼 `ERROR`라는 단어가 없는 Traceback은 **완전히 누락**됐습니다.

### 실제 저장 로그 188건 (`/app/logplus-platform/logs`, `analyses/` 제외)

| 항목 | 결과 |
|---|---|
| 변경 전 범주가 변경 후에 사라진 파일 | **0건** |
| 변경 후 최대 길이 | 4,447자 (6,000자 이내) |
| 중앙값 길이 | 1,002자 → 793자 |

중앙값이 줄어든 이유는 같은 범주의 중복 라인(예: 같은 `ConnectException` 반복)이 문맥에서 빠지고 `(총 N회 발생)`으로 압축됐기 때문입니다. 범주 정보는 하나도 잃지 않았습니다.

---

## 예상 효과

1. **Python/C/빌드 로그 분석 가능**: 폴백 몇 줄이나 마지막 N줄 대신, 범주가 붙은 대표 오류와 Traceback 전체가 모델에 전달됩니다.
2. **횟수 추측 오류 감소**: 프롬프트가 요구하는 `발생 횟수: N회`를 모델이 전처리 결과에서 그대로 읽을 수 있습니다.
3. **예산 효율 향상**: 범주 사이의 중복과 같은 범주 안의 중복 문맥을 제거해, 같은 6,000자 안에 더 많은 서로 다른 오류가 들어갑니다.
4. **Java 동작 유지**: 기존 6개 규칙의 정규식, 순서, 예산이 그대로이고, 실제 로그 188건에서 누락된 범주가 없습니다.

## 남은 한계 및 후속 과제

- **청크 분할은 없습니다.** 모든 범주가 동시에 매칭되는 큰 로그에서는 뒤쪽 범주(C/C++, 빌드)가 예산 때문에 잘릴 수 있습니다.
- 대표 이벤트는 "처음 나온 순서"로 고릅니다. 같은 범주에서 서로 다른 유형이 많을 때는 가장 자주 나온 유형이 생략 집계로 밀릴 수 있습니다.
- 모든 줄에 접두어가 붙는 형식의 Traceback은 블록 경계를 정확히 찾지 못합니다 (2절 참고).
- 다음 학습 데이터(`train_logplus.sh`)의 입력 형식이 바뀝니다. 재학습 전에 후보 몇 건을 직접 확인하는 것을 권장합니다.
