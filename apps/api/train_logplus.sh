#!/usr/bin/env bash
# 이 파일을 /app/logplus-platform/apps/api/train_logplus.sh 로 저장하세요.
set -euo pipefail
umask 077

# ===== 학습 대상: 보통 이 값만 바꾸면 됩니다 =====
export TRAIN_TEAM_ID="test2_project"
export TRAIN_USER_ID=""  # 빈 값이면 해당 팀 전체. 지정하면 그 사용자만 추출.
export TRAIN_MAX_ROWS=500

# ===== DB 설정 =====
export DB_HOST="100.111.116.52"
export DB_PORT=3306
export DB_NAME="LogPlus"
export DB_USER="root"
export DB_PASSWORD=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export TRAIN_SCRIPT_DIR="$SCRIPT_DIR"
export AI_SOURCE_FILE="$SCRIPT_DIR/Aireanalyze.py"
export USER_LOG_ROOT="/app/logplus-platform/logs"
export TRAIN_OUTPUT_DIR="$SCRIPT_DIR/training-output"

# 기존 Colab 주소/토큰을 읽습니다. 내용을 출력하지 않습니다.
if [[ -r "$SCRIPT_DIR/logplus-colab.env" ]]; then
    set -a
    source "$SCRIPT_DIR/logplus-colab.env"
    set +a
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "bash train_logplus.sh --export-only  # 기본: 학습 후보 추출"
    echo "bash train_logplus.sh --submit       # Colab 수신 API 구현 후 전송"
    echo "bash train_logplus.sh --collect JOB_ID  # 결과 수집 재개"
    echo "팀 설정: 파일 상단 TRAIN_TEAM_ID"
    exit 0
fi

python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "Python 3.9 이상이 필요합니다.")'
VENV_DIR="$SCRIPT_DIR/.training-venv"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    python3 -m venv "$VENV_DIR"
fi
if ! "$VENV_DIR/bin/python" -c 'import pymysql, requests' >/dev/null 2>&1; then
    "$VENV_DIR/bin/python" -m pip install 'PyMySQL>=1.1.1,<2' 'requests>=2.32.5,<3'
fi

# 아래는 추출/전송 프로그램입니다. 별도 .py/설정 파일은 필요 없습니다.
exec "$VENV_DIR/bin/python" - "$@" <<'LOGPLUS_EMBEDDED_PYTHON'
#!/usr/bin/env python3
"""Read-only DB export and optional upload of UNVERIFIED training candidates.

This client does not train, approve rows, modify the DB, or switch models.
The matching Colab receiver/semantic verifier still needs to be implemented.
"""
import argparse
import ast
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from urllib.parse import urlsplit, urlunsplit


HERE = Path(os.environ["TRAIN_SCRIPT_DIR"]).resolve()
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_BUNDLE_BYTES = 25 * 1024 * 1024


class SkipRow(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def dump_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_prompt_tools(source_file):
    """Reuse only the current preprocessor and prompt assignments, not API startup."""
    source = source_file.read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    preprocessor = functions.get("_preprocess_log")
    caller = functions.get("_call_ollama")
    if not preprocessor or not caller:
        raise ValueError("Aireanalyze.py에서 전처리/프롬프트 함수를 찾지 못했습니다.")
    limit = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "MAX_LOG_CHARS" for t in node.targets
        ):
            limit = ast.literal_eval(node.value)
    if not isinstance(limit, int) or not 1 <= limit <= 6000:
        raise ValueError("MAX_LOG_CHARS를 확인하세요. 1~6000자만 허용합니다.")
    # This is trusted local application code. No module imports or other app code run.
    namespace = {"re": re, "MAX_LOG_CHARS": limit}
    exec(compile(ast.Module(body=[preprocessor], type_ignores=[]), str(source_file), "exec"), namespace)
    assignments = []
    allowed_nodes = (ast.Constant, ast.JoinedStr, ast.FormattedValue, ast.Name,
                     ast.Load, ast.BinOp, ast.Add)
    for node in caller.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id in ("system", "prompt"):
            if any(not isinstance(part, allowed_nodes) for part in ast.walk(node.value)):
                raise ValueError("프롬프트 생성 코드가 예상과 다릅니다. 추출기를 조정하세요.")
            if any(isinstance(part, ast.Name) and part.id != "log_content" for part in ast.walk(node.value)):
                raise ValueError("프롬프트에 지원하지 않는 변수가 있습니다.")
            assignments.append(node)
    if len(assignments) != 2 or {n.targets[0].id for n in assignments} != {"system", "prompt"}:
        raise ValueError("system/prompt 할당문을 각각 하나씩 찾을 수 없습니다.")
    prompt_code = compile(ast.Module(body=assignments, type_ignores=[]), str(source_file), "exec")

    def messages(log):
        local = {"log_content": log}
        exec(prompt_code, {}, local)
        return [{"role": "system", "content": local["system"]},
                {"role": "user", "content": local["prompt"]}]

    return namespace["_preprocess_log"], messages, sha256(source.encode()), limit


def read_log_file(value, owner_root, analysis=False):
    if not value or not Path(value).is_absolute():
        raise SkipRow("invalid_path")
    path = Path(value).resolve(strict=True)
    expected = (owner_root / "analyses").resolve() if analysis else owner_root
    if not expected.is_relative_to(owner_root):
        raise SkipRow("outside_owner_directory")
    if analysis:
        if path.parent != expected:
            raise SkipRow("outside_owner_directory")
    elif not path.is_relative_to(expected) or path.is_relative_to(owner_root / "analyses"):
        raise SkipRow("outside_owner_directory")
    if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise SkipRow("file_too_large_or_not_regular")
    with path.open("rb") as stream:
        content = stream.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise SkipRow("file_too_large_or_not_regular")
    text = content.decode("utf-8-sig", errors="strict").replace("\r\n", "\n").replace("\r", "\n")
    return content, text


def redact(text):
    """Common credentials only; this is not a guarantee of complete anonymization."""
    if re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", text):
        raise SkipRow("private_key_detected")
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    text = re.sub(
        r'''(?i)(["']?\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)''',
        r"\1[REDACTED]", text,
    )
    text = re.sub(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED_JWT]", text)
    text = re.sub(r"\bAKIA[A-Z0-9]{16}\b", "[REDACTED_ACCESS_KEY]", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[REDACTED_EMAIL]", text)
    return text


def structural_check(answer):
    headings = re.findall(r"(?m)^##\s+(.+?)\s*$", answer)
    if headings != ["원인", "해결 방법"]:
        raise SkipRow("invalid_headings")
    cause, solution = answer.split("## 해결 방법", 1)
    if len(cause.replace("## 원인", "").strip()) < 10 or len(solution.strip()) < 10:
        raise SkipRow("empty_answer_section")
    if len(re.findall(r"[가-힣]", answer)) < 20 or len(answer) > 16000:
        raise SkipRow("invalid_answer_length_or_language")
    if re.search(r"Ollama 호출 실패|AI 분석 실패|HTTPConnectionPool|Max retries exceeded", answer, re.I):
        raise SkipRow("upstream_failure_answer")


def strip_report_header(text):
    if text.startswith("LogPlus AI 분석 리포트"):
        parts = text.split("=" * 60, 1)
        if len(parts) != 2:
            raise SkipRow("invalid_report_header")
        return parts[1].strip()
    return text.strip()


def fetch_rows(team, user, limit):
    import pymysql
    where_user = " AND b.users_id = %s" if user else ""
    sql = """
      SELECT b.build_log_id, b.users_id, b.team_id, b.log_type, b.log_path,
             a.analysis_id, a.analysis_path
      FROM build_logs b
      JOIN ai_analyses a ON a.build_log_id = b.build_log_id
        AND a.users_id = b.users_id AND a.team_id = b.team_id
      WHERE b.team_id = %s
    """ + where_user + """
        AND NOT EXISTS (
          SELECT 1 FROM ai_analyses newer
          WHERE newer.build_log_id = a.build_log_id
            AND newer.users_id = a.users_id AND newer.team_id = a.team_id
            AND newer.analysis_id > a.analysis_id
        )
      ORDER BY a.analysis_id DESC LIMIT %s
    """
    params = [team] + ([user] if user else []) + [limit]
    connection = pymysql.connect(
        host=os.getenv("DB_HOST", "100.111.116.52"), port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "LogPlus"), charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor, connect_timeout=10,
        read_timeout=60, write_timeout=30, autocommit=False,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("START TRANSACTION READ ONLY")
            cursor.execute(sql, params)
            return cursor.fetchall()
    finally:
        connection.rollback()
        connection.close()


def owner_directory(root, team, user):
    for part in (team, user):
        if not part or part in (".", "..") or "/" in part or "\\" in part:
            raise SkipRow("invalid_owner")
    owner = (root / team / user).resolve(strict=True)
    if not owner.is_relative_to(root) or owner != root / team / user:
        raise SkipRow("outside_owner_directory")
    return owner


def build_candidates(rows, root, preprocess, messages):
    skipped, seen, result = Counter(), set(), []
    for row in rows:
        try:
            owner = owner_directory(root, row["team_id"], row["users_id"])
            original_bytes, log = read_log_file(row["log_path"], owner)
            _, answer = read_log_file(row["analysis_path"], owner, analysis=True)
            log, answer = redact(log), redact(strip_report_header(answer))
            structural_check(answer)  # Formatting only; NOT correctness verification.
            selected = preprocess(log)
            if not selected.strip():
                raise SkipRow("empty_input")
            input_hash = sha256(selected.encode())
            if input_hash in seen:
                raise SkipRow("duplicate_input")
            seen.add(input_hash)
            result.append({
                "messages": messages(selected) + [{"role": "assistant", "content": answer}],
                "metadata": {
                    "build_log_id": row["build_log_id"], "analysis_id": row["analysis_id"],
                    "log_type": row["log_type"], "source_log_sha256": sha256(original_bytes),
                    "input_sha256": input_hash, "verification_status": "unverified",
                    "training_allowed": False, "target_origin": "stored_ai_answer",
                    "input_origin": "reconstructed_with_current_preprocessor",
                },
            })
        except SkipRow as exc:
            skipped[str(exc)] += 1
        except (OSError, UnicodeError):
            skipped["unreadable_file"] += 1
    result.sort(key=lambda item: item["metadata"]["input_sha256"])
    return result, dict(skipped)


def training_url():
    explicit = os.getenv("TRAINING_URL", "").strip()
    if explicit:
        value = explicit
    else:
        parsed = urlsplit(os.getenv("OLLAMA_URL", "").strip())
        value = urlunsplit((parsed.scheme, parsed.netloc, "/training/jobs", "", ""))
    parsed = urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != "/training/jobs"):
        raise ValueError("TRAINING_URL 또는 OLLAMA_URL 설정을 확인하세요.")
    return value


def submit(bundle_path, manifest, output):
    import requests
    url = training_url()
    token = os.getenv("OLLAMA_API_KEY", "").strip()
    if not token or any(char.isspace() for char in token):
        raise ValueError("기존 logplus-colab.env의 OLLAMA_API_KEY가 필요합니다.")
    # A retry uses the same key. The receiver must implement persistent idempotency.
    key = sha256(dump_json({"team": manifest["team_id"], "dataset": manifest["dataset_sha256"],
                           "source": manifest["ai_source_sha256"], "mode": manifest["requested_mode"]}).encode())
    with requests.Session() as session, bundle_path.open("rb") as stream:
        session.trust_env = False  # Do not route private tailnet traffic through proxy/netrc.
        response = session.post(
            url, headers={"Authorization": "Bearer " + token, "Idempotency-Key": key},
            data={"manifest": dump_json(manifest)},
            files={"dataset": ("candidates.jsonl", stream, "application/x-ndjson")},
            timeout=(10, 90), allow_redirects=False,
        )
    if response.status_code in (404, 405):
        raise RuntimeError("Colab에 /training/jobs 수신 API가 아직 없습니다. 추출 파일은 보존했습니다.")
    if response.status_code == 409:
        raise RuntimeError("Colab에서 다른 작업이 진행 중입니다. 자동 재전송하지 않았습니다.")
    if response.status_code not in (200, 201, 202):
        raise RuntimeError(f"Colab 전송 실패: HTTP {response.status_code}. 응답 본문은 출력하지 않았습니다.")
    receipt = response.json()
    if not isinstance(receipt, dict) or not isinstance(receipt.get("job_id"), str):
        raise RuntimeError("Colab 응답에 job_id가 없습니다. 재전송 전에 수신 측 작업 상태를 확인하세요.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", receipt["job_id"]):
        raise RuntimeError("Colab job_id 형식이 올바르지 않습니다.")
    # Do not store arbitrary server response bodies (which may contain logs/secrets).
    saved = {"job_id": receipt["job_id"], "submitted_at": datetime.now(timezone.utc).isoformat()}
    (output / "receipt.json").write_text(dump_json(saved) + "\n", encoding="utf-8")
    print("접수된 작업:", receipt["job_id"])
    return receipt["job_id"]


def download_artifact(session, url, headers, item, output):
    name, size, expected_hash = item.get("name", ""), item.get("size"), item.get("sha256", "")
    if (not re.fullmatch(r"(?:checkpoint-[0-9]+|result)\.zip", name)
            or not isinstance(size, int) or not 0 < size <= 2 * 1024**3
            or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)):
        raise RuntimeError("Colab 파일 정보가 올바르지 않습니다.")
    destination = output / name
    if destination.is_file() and destination.stat().st_size == size:
        hasher = hashlib.sha256()
        with destination.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
        if hasher.hexdigest() == expected_hash:
            return
    staging = output / (name + ".part")
    hasher, received = hashlib.sha256(), 0
    with session.get(url + "/artifacts/" + name, headers=headers, stream=True,
                     timeout=(10, 300), allow_redirects=False) as response:
        if response.status_code != 200:
            raise RuntimeError(f"파일 수신 실패: HTTP {response.status_code}")
        with staging.open("wb") as stream:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                received += len(chunk)
                if received > size:
                    raise RuntimeError("수신 파일 크기가 예상보다 큽니다.")
                hasher.update(chunk)
                stream.write(chunk)
    if received != size or hasher.hexdigest() != expected_hash:
        raise RuntimeError("수신 파일 크기/SHA256 검증 실패. .part 파일은 완료 파일로 사용하지 않습니다.")
    os.replace(staging, destination)
    print("서버 보관 완료:", destination)


def collect_results(job_id, output_root):
    import requests
    if not re.fullmatch(r"job_[0-9a-f]{32}", job_id):
        raise ValueError("job_ 뒤에 32자리 ID가 필요합니다.")
    token = os.getenv("OLLAMA_API_KEY", "").strip()
    if not token or any(char.isspace() for char in token):
        raise ValueError("기존 logplus-colab.env의 OLLAMA_API_KEY가 필요합니다.")
    output = Path(output_root) / job_id
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    url = training_url() + "/" + job_id
    headers = {"Authorization": "Bearer " + token}
    deadline, last_state, failures = time.monotonic() + 95 * 60, None, 0
    terminal = {"adapter_ready", "skipped", "failed", "interrupted"}
    print("결과 수집 폴더:", output)
    print("이 프로세스가 실행되는 동안 체크포인트와 최종 결과를 자동으로 내려받습니다.")
    with requests.Session() as session:
        session.trust_env = False
        while time.monotonic() < deadline:
            try:
                response = session.get(url, headers=headers, timeout=(10, 30), allow_redirects=False)
                if response.status_code == 404:
                    raise RuntimeError("작업을 찾을 수 없습니다. Colab 초기화 여부를 확인하세요. 이미 받은 파일은 서버에 남습니다.")
                if response.status_code != 200:
                    raise RuntimeError(f"상태 조회 실패: HTTP {response.status_code}")
                state = response.json()
                if not isinstance(state, dict) or state.get("job_id") != job_id:
                    raise RuntimeError("작업 상태 응답이 올바르지 않습니다.")
                if state.get("state") != last_state:
                    last_state = state.get("state")
                    print("작업 상태:", last_state, flush=True)
                response = session.get(url + "/artifacts", headers=headers, timeout=(10, 30), allow_redirects=False)
                if response.status_code != 200:
                    raise RuntimeError(f"파일 목록 조회 실패: HTTP {response.status_code}")
                items = response.json().get("artifacts")
                if not isinstance(items, list):
                    raise RuntimeError("파일 목록 응답이 올바르지 않습니다.")
                for item in items:
                    download_artifact(session, url, headers, item, output)
                (output / "last-status.json").write_text(dump_json(state) + "\n", encoding="utf-8")
                failures = 0
                if state.get("artifact_error"):
                    raise RuntimeError("Colab 결과 묶음 생성 실패. 이미 수신한 체크포인트를 확인하세요.")
                if last_state == "interrupted":
                    raise RuntimeError("Colab 작업이 중단되었습니다. 수신한 체크포인트는 서버에 보관했습니다.")
                if last_state in terminal and state.get("artifacts_ready") and (output / "result.zip").is_file():
                    if last_state == "skipped":
                        print("데이터 부족/검증 기준 미충족으로 학습을 건너뛰었습니다. 상세 사유는 last-status.json에 저장했습니다.")
                    elif last_state == "adapter_ready":
                        print("학습 어댑터를 서버에 보관했습니다. 기존 Ollama 모델은 자동 교체하지 않았습니다.")
                    else:
                        raise RuntimeError("학습이 실패/중단되었습니다. 수집한 result.zip과 체크포인트를 확인하세요.")
                    return
            except requests.RequestException:
                failures += 1
                print(f"Colab 연결 재확인 중 ({failures}/8). 수신 완료 파일은 보존합니다.", flush=True)
                if failures >= 8:
                    raise RuntimeError("연결 재시도 한도 초과. Colab 연결 후 --collect JOB_ID로 수집을 재개하세요.") from None
            time.sleep(15)
    raise RuntimeError("수집 대기 시간 95분을 초과했습니다. --collect JOB_ID로 재개할 수 있습니다.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--export-only", action="store_true", help="기본 동작: 추출만 실행")
    mode.add_argument("--submit", action="store_true", help="Colab 검증/학습 작업 API에 후보 데이터 전송")
    mode.add_argument("--collect", metavar="JOB_ID", help="DB 조회 없이 기존 작업의 체크포인트/결과 수집 재개")
    args = parser.parse_args()
    os.umask(0o077)
    if args.collect:
        collect_results(args.collect, Path(os.getenv("TRAIN_OUTPUT_DIR", str(HERE / "training-output"))))
        return
    team = os.getenv("TRAIN_TEAM_ID", "").strip()
    if not team:
        raise ValueError("TRAIN_TEAM_ID를 지정하세요.")
    limit = int(os.getenv("TRAIN_MAX_ROWS", "500"))
    if not 1 <= limit <= 10000:
        raise ValueError("TRAIN_MAX_ROWS는 1~10000이어야 합니다.")
    preprocess, messages, source_hash, max_chars = load_prompt_tools(
        Path(os.getenv("AI_SOURCE_FILE", str(HERE / "Aireanalyze.py"))).resolve(strict=True))
    root = Path(os.getenv("USER_LOG_ROOT", "/app/logplus-platform/logs")).resolve(strict=True)
    rows = fetch_rows(team, os.getenv("TRAIN_USER_ID", "").strip(), limit)
    records, skipped = build_candidates(rows, root, preprocess, messages)
    print(f"조회={len(rows)}건 / 후보={len(records)}건 / 제외={sum(skipped.values())}건")
    print("제외 사유:", dump_json(skipped))
    if not records:
        print("학습 후보가 없어 전송하지 않습니다.")
        return
    serialized = "".join(dump_json(record) + "\n" for record in records).encode("utf-8")
    if len(serialized) > MAX_BUNDLE_BYTES:
        raise ValueError("전송 파일이 25MiB를 넘습니다. TRAIN_MAX_ROWS를 줄이세요.")
    output_root = Path(os.getenv("TRAIN_OUTPUT_DIR", str(HERE / "training-output")))
    output_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    output = output_root / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    output.mkdir(mode=0o700)
    bundle = output / "candidates.jsonl"
    bundle.write_bytes(serialized)
    manifest = {
        "schema_version": "logplus-candidates-v1", "team_id": team,
        "base_model": "Qwen/Qwen3-4B-Instruct-2507", "records": len(records),
        "dataset_sha256": sha256(serialized), "ai_source_sha256": source_hash,
        "max_input_chars": max_chars, "requested_mode": "validate_then_train",
        "unverified_training_allowed": False, "automatic_promotion": False,
        "created_at": datetime.now(timezone.utc).isoformat(), "skipped": skipped,
    }
    (output / "manifest.json").write_text(dump_json(manifest) + "\n", encoding="utf-8")
    print("추출 폴더:", output)
    print("현재 결과는 미검증 AI 답변 후보입니다. 형식 검사는 정답 검증이 아닙니다.")
    if args.submit:
        job_id = submit(bundle, manifest, output)
        collect_results(job_id, output_root)
    else:
        print("추출만 완료했습니다. Colab 수신 API 구현 후 --submit으로 전송하세요.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        # DB/HTTP exceptions may contain credential URLs; do not dump raw exception text.
        if isinstance(exc, (ValueError, RuntimeError)):
            print("실패:", str(exc), file=sys.stderr)
        else:
            print(f"실패: {type(exc).__name__}. DB 접속/파일 권한/Colab 연결을 확인하세요.", file=sys.stderr)
        sys.exit(1)
LOGPLUS_EMBEDDED_PYTHON

