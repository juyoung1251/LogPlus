"""Date aliases for immutable job directories; latest tracks applied models only."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import uuid
import zipfile

KST = timezone(timedelta(hours=9))
KNOWN_RESTORED = {
    "job_7ae2c7f00b3c45fab6d19452a03e5a37":
        "ce5f44d75e67442dc68b9e9c5d4f5976ea9609cd2f61a5aa5933a809c0788b56"
}
LABELS = {"adapter_ready": "학습완료", "failed": "실패", "skipped": "학습생략", "interrupted": "중단"}


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, value):
    path = Path(path)
    temp = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write("\n")
        temp.chmod(0o600)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def parse_time(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("학습 날짜의 시간대가 없습니다.")
    return dt


def set_alias(root, name, target, replace=False):
    alias = root / name
    if os.path.lexists(alias):
        if not alias.is_symlink():
            raise ValueError("기존 일반 파일/폴더를 덮어쓰지 않습니다: " + str(alias))
        if alias.resolve() == target.resolve():
            return
        if not replace:
            raise ValueError("날짜 경로가 다른 작업을 가리킵니다: " + str(alias))
    temp = root / (".alias-" + uuid.uuid4().hex)
    try:
        temp.symlink_to(target.relative_to(root), target_is_directory=True)
        os.replace(temp, alias)
    finally:
        temp.unlink(missing_ok=True)


def archive_result(job_dir, state=None, active=None):
    """No moves or model changes. Returns a verified, readable alias/manifest."""
    import fcntl
    original = Path(job_dir)
    if original.is_symlink() or not re.fullmatch(r"job_[0-9a-f]{32}", original.name):
        raise ValueError("원본 job 폴더가 필요합니다.")
    job = original.resolve(strict=True)
    root = job.parent
    bundle = job / "result.zip"
    if bundle.is_symlink() or not bundle.is_file():
        raise ValueError("수신 완료된 result.zip이 필요합니다(.part 제외).")
    # Never extract the ZIP, import its code, or load pickle weights here.
    with zipfile.ZipFile(bundle) as z:
        infos = z.infolist()
        if len(infos) > 20000 or sum(i.file_size for i in infos) > 4 * 1024**3:
            raise ValueError("결과 ZIP 크기가 비정상입니다.")
        if len({i.filename for i in infos}) != len(infos):
            raise ValueError("중복 ZIP 경로")
        for i in infos:
            p = PurePosixPath(i.filename)
            if p.is_absolute() or ".." in p.parts or "\\" in i.filename:
                raise ValueError("안전하지 않은 ZIP 경로")
        if z.testzip():
            raise ValueError("결과 ZIP CRC 오류")
        def small_json(name, default):
            if name not in z.namelist():
                return default
            if z.getinfo(name).file_size > 1024 * 1024:
                raise ValueError("결과 메타데이터 크기 초과")
            return json.loads(z.read(name))
        packaged = small_json("state.json", {})
        result = small_json("worker-result.json", {})
        if packaged.get("job_id") != job.name:
            raise ValueError("ZIP과 원본 폴더의 job_id가 다릅니다.")
        info = state if state is not None else load_json(job / "last-status.json") if (job / "last-status.json").is_file() else packaged
        if not isinstance(info, dict) or info.get("job_id") != job.name:
            raise ValueError("상태 파일의 job_id가 다릅니다.")
        # A stopped collector may have saved 'training' before the final ZIP arrived.
        if info.get("state") not in LABELS:
            info = packaged
        status = info.get("state")
        if status not in LABELS:
            raise ValueError("종료된 학습 작업만 정리합니다.")
        trained = (status == "adapter_ready" and result.get("status") == "adapter_ready"
            and result.get("base_model") == "Qwen/Qwen3-4B-Instruct-2507"
            and isinstance(result.get("optimizer_steps"), int) and result["optimizer_steps"] > 0
            and "adapter/adapter_model.safetensors" in z.namelist())
    created = parse_time(info.get("created_at") or packaged["created_at"])
    updated = parse_time(info.get("updated_at") or packaged.get("updated_at") or created.isoformat())
    checksum = sha256(bundle)
    name = created.astimezone(KST).strftime("%Y-%m-%d_%H-%M-%S") + "_" + LABELS[status] + "_" + job.name[4:12]
    promotion = info.get("promotion") or info.get("result", {}).get("promotion", {})
    confirmed = bool(trained and isinstance(promotion, dict) and promotion.get("status") == "applied"
                     and info.get("restore_ok") is True)
    reason = "promotion_applied" if confirmed else None
    if trained and KNOWN_RESTORED.get(job.name) == checksum:
        confirmed, reason = True, "previously_restored_and_smoke_tested_bundle_sha256"
    activation = updated.timestamp()
    if active is not None:
        # A live registry is stronger than old saved promotion status.
        confirmed = bool(trained and isinstance(active, dict) and active.get("job_id") == job.name
            and active.get("adapter_applied") is True and active.get("smoke_passed") is True
            and re.fullmatch(r"logplus-qwen3:trained-[a-z0-9-]+", active.get("model", ""))
            and re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", active.get("digest", "")))
        if confirmed:
            reason = "live_active_model_registry"
            activation = float(active.get("activated_at_unix") or activation)
    descriptor = {"schema": "logplus-dated-result-v1", "job_id": job.name, "state": status,
        "created_at": created.isoformat(), "created_at_kst": created.astimezone(KST).isoformat(),
        "date_directory": name, "job_directory": job.name, "result_file": "result.zip",
        "result_bytes": bundle.stat().st_size, "result_sha256": checksum,
        "trained_adapter_present": trained, "applied_model_confirmed": confirmed,
        "application_evidence": reason, "activation_epoch": activation}
    with (root / ".archive.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        set_alias(root, name, job)
        save_json(job / "archive-info.json", descriptor)
        previous = load_json(root / "latest-info.json") if (root / "latest-info.json").is_file() else None
        # An out-of-order collection must not roll latest back to an older model.
        if confirmed and (not previous or activation >= previous.get("activation_epoch", 0)):
            set_alias(root, "latest", root / name, replace=True)
            save_json(root / "latest-info.json", descriptor)
    print("날짜별 결과:", root / name / "result.zip", flush=True)
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    report = []
    for job in sorted(args.root.glob("job_*")):
        if job.is_dir() and not job.is_symlink() and (job / "result.zip").is_file():
            try:
                report.append(archive_result(job))
            except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
                print("정리 제외:", job.name, type(error).__name__, str(error), flush=True)
    save_json(args.root / "date-index.json", report)
    print("정리 완료:", len(report), "건 / latest:", (args.root / "latest").resolve())


if __name__ == "__main__":
    main()
