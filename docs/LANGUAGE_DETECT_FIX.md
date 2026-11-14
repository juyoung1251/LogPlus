# 언어별 빌드 분포 — Python 빌드가 C/C++로 집계되던 문제 수정

작성일: 2026-11-07

## 1. 언어 판별 로직 위치

| 위치 | 역할 |
|---|---|
| `apps/api/Dashboard.py` — `LANGUAGE_RULES`, `_detect_language()`, `GET /dashboard/language-distribution` | 대시보드 "언어별 빌드 분포" 집계 |
| `services/builder/build.sh` STEP 2 (`LANG_TYPE=...`) | Dockerfile 이 없을 때 언어를 감지해 Dockerfile 자동 생성 |

> 참고: `build_logs` 테이블에는 **`language` 컬럼이 없다.**
> 컬럼은 `build_log_id, users_id, team_id, log_type(run/lib), log_path, created_at` 뿐이다.
> 그래서 언어는 DB에 저장되지 않고, 조회할 때마다 계산된다.

## 2. 기존 판별 방식

- `language_distribution()` 은 팀의 RUN 빌드마다 `users_id` 만 꺼내고,
  `projects/<team_id>/<users_id>/` **작업 폴더의 현재 상태**를 보고 언어를 정했다 (사용자당 1번만 판별해서 캐시).
- 폴더 규칙 (위에서부터 먼저 맞는 것):
  1. Python: `requirements.txt` 또는 최상위 `*.py`
  2. Node: `package.json`
  3. Java-Maven: `pom.xml` / Java-Gradle: `build.gradle`
  4. C/C++: `CMakeLists.txt` **또는** `Makefile` **또는** 최상위 `*.cpp`/`*.c`

## 3. 원인

### 주원인: 빌드 당시가 아니라 "지금 폴더"로 판별
`build.sh` 는 push 할 때마다 작업 폴더를 `git reset --hard origin/master` 로 덮어쓴다.
한 사용자가 Python 저장소를 여러 번 빌드한 뒤 C 코드를 push하면, 폴더에는 `Makefile + main.c` 만 남는다.
그 결과 **그 사용자의 과거 Python 빌드가 전부 C/C++로 집계**됐다. 함수 docstring에도
"과거 빌드도 지금 폴더의 언어로 집계된다"고 적혀 있었다.

판별 순서 문제는 아니었다. Python 체크는 이미 C/C++보다 먼저 실행되고 있었다.

### 부원인: 폴더 규칙이 좁거나 넓음 (3순위 fallback으로만 쓰이도록 함께 수정)
- Python: `pyproject.toml` / `setup.py` / `Pipfile` 만 있거나 소스가 `src/` 아래에 있으면 놓쳤다.
- C/C++: `Makefile` 하나만 있어도 C/C++로 판정했다. Python 프로젝트도 Makefile을 흔히 쓴다.

## 4. 실제 DB 확인 결과

```
build_logs (team_id, users_id, log_type, count)
test_project   test1  run 4 / lib 4
test2_project  test2  run 90 / lib 90
```

- `projects/test2_project/test2` 의 현재 상태는 `Makefile`, `main.c`, `Dockerfile(FROM gcc)` 이다.
- 그런데 test2 의 RUN 로그 90건을 내용으로 분류하면, **65건이 Python Traceback**
  (`File "/app/main.py"`, `ModuleNotFoundError`)이고, 해당 LIB 로그의 베이스 이미지는 `python:3.12-slim` 이었다.
- 기존 API 결과: `test2_project → C/C++ 90건 (100%)` ← 잘못된 값.
- LIB 로그 90건 중 87건은 "Dockerfile 감지"였다(자동 감지를 거치지 않음). 그래서 `감지된 언어:` 줄만으로는 부족하고,
  docker build 출력의 베이스 이미지까지 봐야 한다.

## 5. 수정 방향

빌드 1건마다 **그 빌드의 LIB 로그**로 언어를 정한다. LIB 로그는 빌드 시점에 기록된 불변 기록이다.
`<ts>_RUN.log` 와 `<ts>_LIB.log` 는 build.sh 가 같은 타임스탬프로 만들기 때문에 경로만으로 짝을 찾는다.

| 순위 | 단서 | 예 |
|---|---|---|
| 1 | build.sh 자동 감지 결과 | `감지된 언어: python` |
| 2 | docker build 베이스 이미지 | `load metadata for docker.io/library/python:3.12-slim`, `Step 1/4 : FROM node:20` |
| 3 | (단서 없을 때만) 현재 작업 폴더 | 개선된 `LANGUAGE_RULES` |

베이스 이미지 매핑: `python`/`pypy`→Python, `node`→Node, `maven`→Java-Maven, `gradle`→Java-Gradle,
`openjdk`/`eclipse-temurin`/`amazoncorretto`→Java, `gcc`/`clang`→C/C++.
(`docker/dockerfile:1` 같은 frontend 이미지는 매핑에 없어서 건너뛴다.)

폴더 규칙 (3순위):
- Python: `requirements.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`, 또는 `*.py` (최상위 + 1단계 하위)
- C/C++: **실제 소스** `*.c/*.cc/*.cpp/*.cxx` 가 있을 때만. Makefile/CMakeLists.txt 만 있거나 `.h` 만 있으면 C/C++로 보지 않는다.
- Python이 C/C++보다 먼저다. Python 프로젝트에 C 확장(`ext/fast.c`)이 섞여 있어도 Python으로 판정한다.

> 요청안의 "C/C++은 소스 + Makefile/CMakeLists.txt 조합일 때만"은 그대로 적용하지 않았다.
> `main.c` 하나만 있는 저장소도 build.sh 는 `gcc *.c` 로 정상 빌드하기 때문에, 빌드 도구 파일은 요구하지 않고
> **소스 파일을 필수 조건**으로 했다.

## 6. 수정된 파일

### `apps/api/Dashboard.py`
- `BUILD_SH_LANG_RE`, `BUILD_SH_LANGS`, `BASE_IMAGE_RE`, `BASE_IMAGES` 추가
- `_lib_log_path()`: RUN 로그 경로에서 LIB 로그 경로를 만든다
- `_language_from_lib_log()`: LIB 로그를 한 줄씩 읽는다. `감지된 언어:` 가 보이면 즉시 반환하고, 없으면 처음 찾은 베이스 이미지 언어를 반환한다
- `LANGUAGE_RULES` 개선(위 규칙) + `_has_files()` 헬퍼
- `language_distribution()`: 사용자 단위 → **빌드 단위** 판별. 폴더 판별은 fallback일 때만 사용자별로 캐시한다
- 응답 형식(`total`, `languages[{language,count,percent}]`)은 그대로라서 프론트엔드는 수정하지 않았다

### `services/builder/build.sh` (STEP 2 자동 감지)
- Python 감지에 `pyproject.toml`/`setup.py`/`setup.cfg`/`Pipfile` 와 1단계 하위 `*.py` 를 추가했다
- `cpp`: `CMakeLists.txt` **+ 소스**가 있거나, 최상위 `*.cpp` 가 있을 때
- `c`: 최상위 `*.c` 가 있을 때. **Makefile 만으로는 더 이상 `c` 로 판정하지 않는다** (어차피 `gcc *.c` 가 실패하던 경우라, 이제는 언어 감지 실패로 명확히 처리된다)

## 7. Before / After 로직 비교

```python
# Before — 사용자 폴더의 현재 상태로 사용자당 1번 판별
for (users_id,) in builds:
    if users_id not in languages:
        languages[users_id] = _detect_language(project_root / team_id / users_id)
    counter[languages[users_id]] += 1

# After — 빌드마다 그 빌드의 LIB 로그로 판별, 단서 없을 때만 폴더
for users_id, log_path in builds:
    language = _language_from_lib_log(_lib_log_path(log_path))
    if language is None:
        language = folder_languages.setdefault(...)  # 개선된 LANGUAGE_RULES
    counter[language] += 1
```

```
C/C++ 규칙  Before: CMakeLists.txt or Makefile or *.cpp or *.c   (최상위)
            After : *.c / *.cc / *.cpp / *.cxx 소스 존재           (최상위 + 1단계)
Python 규칙 Before: requirements.txt or *.py                       (최상위)
            After : requirements.txt / pyproject.toml / setup.py / setup.cfg / Pipfile or *.py (최상위 + 1단계)
```

## 8. 테스트 결과

### 실제 DB (`GET /dashboard/language-distribution`)

| team | Before | After |
|---|---|---|
| test2_project (90건) | C/C++ 90 (100%) | **Python 66 (73.3%)**, C/C++ 14 (15.6%), Java 7 (7.8%), Node 3 (3.3%) |
| test_project (4건) | Python 4 | Python 4 |

실행 중인 서버(uvicorn `--reload`)에서도 `curl` 로 같은 After 값이 나오는 것을 확인했다.

RUN 로그 내용과 교차 검증했다(test2, 90건):
- Python으로 판정된 66건 = Traceback이 있는 65건 + Docker 빌드 실패로 실행이 없던 1건 (베이스 이미지 `python:3.12-slim`)
- C/C++ 14건은 모두 `gcc:13/14/latest` 이미지였다. 실행 로그도 `LogPlus C App`, `std::invalid_argument`, 컴파일 실패 등이라 실제 C/C++ 빌드다
- Python Traceback이 있는데 Python이 아닌 것으로 판정된 건은 0건이다

### 단위 테스트 (임시 폴더/로그, 16케이스 전부 PASS)

```
['main.py']                                   -> Python
['pyproject.toml', 'src/pkg/__init__.py']     -> Python
['src/app.py', 'Makefile']                    -> Python
['Makefile', 'main.py', 'ext/fast.c', '.h']   -> Python
['Makefile', 'README.md']                     -> 기타
['include/foo.h', 'Makefile']                 -> 기타
['Makefile', 'main.c']                        -> C/C++
['CMakeLists.txt', 'src/main.cpp']            -> C/C++
['package.json'] -> Node / ['pom.xml'] -> Java-Maven
LIB '감지된 언어: python'                       -> Python
LIB '감지된 언어: c'                            -> C/C++
LIB 'load metadata for .../python:3.12-slim'    -> Python
LIB 'dockerfile:1' + '.../gcc:13'               -> C/C++
LIB 'Step 1/4 : FROM node:20'                   -> Node
LIB 'Dockerfile 감지 ...' (단서 없음)            -> None → 폴더 fallback
```

`bash -n services/builder/build.sh` 문법 검사 통과.

## 9. 남은 과제 / 참고
- LIB 로그 파일이 지워진 과거 빌드는 여전히 현재 폴더로 판별한다. 정확히 남기려면 `build_logs` 에 `language` 컬럼을 추가하고,
  build.sh 가 `/logs` POST 할 때 함께 저장하는 방식을 권장한다 (DB 마이그레이션 필요해서 이번에는 하지 않았다).
- build.sh 의 Dockerfile 직접 제공 경로에서도 `감지된 언어:` 를 남기면 2순위(베이스 이미지 파싱) 의존도를 줄일 수 있다.
- 대시보드는 Java 베이스 이미지(`eclipse-temurin` 등)를 `Java` 로 표시한다. Maven/Gradle 구분은 이미지가 `maven`/`gradle` 일 때만 된다.
