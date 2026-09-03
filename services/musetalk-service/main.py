"""MuseTalk asynchronous rendering service for the Meihua digital-human pipeline.

Contract:
  GET  /health
  GET  /avatars
  POST /avatars/prep
  POST /renders
  GET  /renders/{job_id}
  POST /renders/{job_id}/cancel

The service only renders silent lip-sync videos. The orchestrator owns media
registration, OBS delivery and the single native audio clock.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MUSETALK_HOME = Path(os.environ.get("MUSETALK_HOME", "E:/meihua/MuseTalk"))
RESULTS_DIR = MUSETALK_HOME / "results" / "v15" / "avatars"
UNET_CONFIG = MUSETALK_HOME / "models" / "musetalkV15" / "musetalk.json"
UNET_MODEL = MUSETALK_HOME / "models" / "musetalkV15" / "unet.pth"
WHISPER_DIR = MUSETALK_HOME / "models" / "whisper"
FFMPEG_DIR = Path(os.environ.get("MEIHUA_FFMPEG_PATH", "E:/meihua/meihua-live/tools/ffmpeg"))
JOBS_PATH = MUSETALK_HOME / "results" / "v15" / "service-jobs.json"
FPS = 30


def _positive_int(value: str | None) -> int | None:
    try:
        parsed = int((value or "").strip())
        return parsed if parsed > 0 else None
    except Exception:
        return None


def _detect_gpu_memory_mb() -> int:
    try:
        import torch
        if not torch.cuda.is_available():
            return 0
        return int(torch.cuda.get_device_properties(0).total_memory / 1024 / 1024)
    except Exception:
        return 0


def _resolve_gpu_profile(vram_mb: int) -> str:
    requested = os.environ.get("MEIHUA_GPU_PROFILE", "").strip().upper()
    if requested in {"CPU_COMPAT", "SAFE_8GB", "STANDARD_12GB", "ENHANCED_16GB"}:
        return requested
    if vram_mb <= 0:
        return "CPU_COMPAT"
    if vram_mb <= 8192:
        return "SAFE_8GB"
    if vram_mb <= 12288:
        return "STANDARD_12GB"
    return "ENHANCED_16GB"


def _safe_batch_ceiling(profile: str) -> int:
    return {
        "CPU_COMPAT": 1,
        "SAFE_8GB": 1,
        "STANDARD_12GB": 2,
        "ENHANCED_16GB": 4,
    }.get(profile, 1)


GPU_VRAM_MB = _positive_int(os.environ.get("MEIHUA_GPU_VRAM_MB")) or _detect_gpu_memory_mb()
GPU_PROFILE = _resolve_gpu_profile(GPU_VRAM_MB)
SAFE_BATCH_CEILING = _safe_batch_ceiling(GPU_PROFILE)
REQUESTED_BATCH_SIZE = _positive_int(os.environ.get("MUSETALK_BATCH_SIZE")) or SAFE_BATCH_CEILING
# A user can lower the value, but the normal launch path cannot accidentally
# raise batch size above the profile's tested envelope (8 GB = exactly one).
BATCH_SIZE = max(1, min(REQUESTED_BATCH_SIZE, SAFE_BATCH_CEILING))


INFERENCE_TIMEOUT_SECONDS = max(600, int(os.environ.get("MUSETALK_INFERENCE_TIMEOUT_SECONDS", "7200")))


def _safe_identifier(value: str, label: str) -> str:
    safe = "".join(ch for ch in value if ch.isalnum() or ch in "-_")
    if not safe or safe != value:
        raise ValueError(f"invalid {label}: use letters, numbers, '-' or '_' only")
    return safe


def _musetalk_python() -> str:
    return os.environ.get("MUSETALK_PYTHON", sys.executable)


def _subprocess_environment() -> dict[str, str]:
    environment = dict(os.environ)
    search_paths = [str(MUSETALK_HOME), str(MUSETALK_HOME / "musetalk" / "utils")]
    extra_python_path = environment.get("MUSETALK_PYTHONPATH", "").strip()
    if extra_python_path:
        search_paths.insert(0, extra_python_path)
    existing_python_path = environment.get("PYTHONPATH", "").strip()
    if existing_python_path:
        search_paths.append(existing_python_path)
    environment["PYTHONPATH"] = os.pathsep.join(search_paths)
    environment["PATH"] = os.pathsep.join([str(FFMPEG_DIR), environment.get("PATH", "")])
    return environment


def _run_realtime_inference(inference_config: Path, prepare_only: bool = False) -> None:
    script = MUSETALK_HOME / "scripts" / "realtime_inference.py"
    if not script.exists():
        raise RuntimeError(f"MuseTalk script missing: {script}")
    command = [
        _musetalk_python(), str(script), "--version", "v15",
        "--unet_config", str(UNET_CONFIG),
        "--unet_model_path", str(UNET_MODEL),
        "--whisper_dir", str(WHISPER_DIR),
        "--ffmpeg_path", str(FFMPEG_DIR),
        "--inference_config", str(inference_config),
        "--result_dir", str(MUSETALK_HOME / "results"),
        "--fps", str(FPS),
        "--batch_size", str(BATCH_SIZE),
    ]
    if prepare_only:
        command.append("--prepare_only")
    else:
        command.append("--silent_output")
    completed = subprocess.run(
        command, cwd=str(MUSETALK_HOME), capture_output=True,
        text=True, timeout=INFERENCE_TIMEOUT_SECONDS, check=False,
        env=_subprocess_environment(),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "")[-800:]
        raise RuntimeError(f"MuseTalk inference failed: {detail}")


def _write_inference_config(
    avatar_id: str,
    video_path: str,
    audio_path: str,
    prepare: bool,
    output_key: str,
) -> Path:
    avatar_id = _safe_identifier(avatar_id, "avatar_id")
    output_key = _safe_identifier(output_key, "output_key")
    config_dir = MUSETALK_HOME / "configs" / "service"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / f"render-{avatar_id}-{int(time.time() * 1000)}.yaml"
    payload = {
        avatar_id: {
            "preparation": prepare,
            "bbox_shift": 5,
            "video_path": video_path,
            "audio_clips": {output_key: audio_path},
        }
    }
    # JSON is valid YAML and avoids an additional runtime dependency.
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return config_path


def _avatar_dir(avatar_id: str) -> Path:
    return RESULTS_DIR / _safe_identifier(avatar_id, "avatar_id")


def _avatar_is_prepared(avatar_id: str) -> bool:
    directory = _avatar_dir(avatar_id)
    required = [
        directory / "avator_info.json",
        directory / "coords.pkl",
        directory / "latents.pt",
        directory / "mask_coords.pkl",
    ]
    return (
        all(path.exists() for path in required)
        and any((directory / "full_imgs").glob("*.png"))
        and any((directory / "mask").glob("*.png"))
    )


def _video_output(avatar_id: str, reading_id: str) -> Path:
    safe = _safe_identifier(reading_id, "reading_id")
    return _avatar_dir(avatar_id) / "vid_output" / f"{safe}.mp4"


def _wav_duration_ms(audio_path: str) -> int:
    try:
        import wave
        with wave.open(audio_path, "rb") as handle:
            return int(handle.getnframes() / (handle.getframerate() or 1) * 1000)
    except Exception:
        return 0


app = FastAPI(title="meihua-musetalk-service")
jobs_lock = threading.Lock()
gpu_work_lock = threading.Lock()
gpu_state_lock = threading.Lock()
gpu_active_task: dict | None = None
gpu_waiting_count = 0


@contextmanager
def single_gpu_task(kind: str, identifier: str):
    """Serialize both preparation and render subprocesses on one GPU lane."""
    global gpu_active_task, gpu_waiting_count
    queued_at = int(time.time() * 1000)
    with gpu_state_lock:
        gpu_waiting_count += 1
    gpu_work_lock.acquire()
    with gpu_state_lock:
        gpu_waiting_count -= 1
        gpu_active_task = {"kind": kind, "identifier": identifier, "started_at": int(time.time() * 1000), "queued_at": queued_at}
    try:
        yield
    finally:
        with gpu_state_lock:
            gpu_active_task = None
        gpu_work_lock.release()


def gpu_runtime_status() -> dict:
    free_mb = None
    total_mb = GPU_VRAM_MB or None
    cuda_ready = False
    try:
        import torch
        cuda_ready = bool(torch.cuda.is_available())
        if cuda_ready:
            free_bytes, total_bytes = torch.cuda.mem_get_info()
            free_mb = int(free_bytes / 1024 / 1024)
            total_mb = int(total_bytes / 1024 / 1024)
    except Exception:
        pass
    with gpu_state_lock:
        active = dict(gpu_active_task) if gpu_active_task else None
        queued = gpu_waiting_count
    return {
        "cuda_ready": cuda_ready,
        "gpu_profile": GPU_PROFILE,
        "gpu_total_mb": total_mb,
        "gpu_free_mb": free_mb,
        "batch_size": BATCH_SIZE,
        "safe_batch_ceiling": SAFE_BATCH_CEILING,
        "active_task": active,
        "queued_gpu_tasks": queued,
    }


def _load_jobs() -> dict[str, dict]:
    if not JOBS_PATH.exists():
        return {}
    try:
        stored = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
        loaded = stored if isinstance(stored, dict) else {}
    except Exception:
        return {}
    now = int(time.time() * 1000)
    for job in loaded.values():
        if isinstance(job, dict) and job.get("status") in {"QUEUED", "PREPARING", "RENDERING"}:
            job.update(status="QUEUED", stage="RECOVERED_AFTER_RESTART", updated_at=now)
    return {key: value for key, value in loaded.items() if isinstance(key, str) and isinstance(value, dict)}


def _save_jobs_locked() -> None:
    JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = JOBS_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, JOBS_PATH)


jobs: dict[str, dict] = _load_jobs()


class PrepBody(BaseModel):
    avatar_id: str
    video_path: str


class RenderBody(BaseModel):
    avatar_id: str
    audio_path: str
    reading_id: str


def _prep_job_serial(job_id: str, body: PrepBody) -> None:
    with jobs_lock:
        if jobs[job_id]["status"] == "CANCELED":
            return
        jobs[job_id].update(status="PREPARING", stage="PREPROCESSING", progress=10, updated_at=int(time.time() * 1000))
        _save_jobs_locked()
    try:
        avatar_directory = _avatar_dir(body.avatar_id)
        if _avatar_is_prepared(body.avatar_id):
            with jobs_lock:
                if jobs[job_id]["status"] != "CANCELED":
                    jobs[job_id].update(status="READY", stage="COMPLETE", progress=100, prepared=True, cached=True, updated_at=int(time.time() * 1000))
                    _save_jobs_locked()
            return
        # MuseTalk writes many intermediate files.  Run it under a unique
        # staging avatar id and publish the completed directory only after all
        # required artifacts have been verified.  This prevents a crash or
        # timeout from making a partial directory look READY to the API.
        staging_id = f"{body.avatar_id}__prep_{job_id.replace('-', '')}"
        staging_directory = _avatar_dir(staging_id)
        if staging_directory.exists():
            shutil.rmtree(staging_directory)
        default_audio = MUSETALK_HOME / "data" / "audio" / "sun.wav"
        config = _write_inference_config(
            staging_id, body.video_path, str(default_audio), prepare=True,
            output_key=f"prep_{body.avatar_id}",
        )
        _run_realtime_inference(config, prepare_only=True)
        if not _avatar_is_prepared(staging_id):
            raise RuntimeError("MUSETALK_PREP_INCOMPLETE")
        with jobs_lock:
            if jobs[job_id]["status"] == "CANCELED":
                shutil.rmtree(staging_directory, ignore_errors=True)
                return
        backup_directory = _avatar_dir(f"{body.avatar_id}__backup_{job_id.replace('-', '')}")
        if backup_directory.exists():
            shutil.rmtree(backup_directory)
        if avatar_directory.exists():
            os.replace(avatar_directory, backup_directory)
        try:
            os.replace(staging_directory, avatar_directory)
        except Exception:
            if backup_directory.exists() and not avatar_directory.exists():
                os.replace(backup_directory, avatar_directory)
            raise
        if backup_directory.exists():
            shutil.rmtree(backup_directory)
        with jobs_lock:
            if jobs[job_id]["status"] != "CANCELED":
                jobs[job_id].update(status="READY", stage="COMPLETE", progress=100, prepared=True, updated_at=int(time.time() * 1000))
                _save_jobs_locked()
    except Exception as exc:
        # Best-effort cleanup of the staging directory.  The final published
        # avatar is never deleted on a failed retry.
        try:
            if "staging_id" in locals():
                staging_directory = _avatar_dir(staging_id)
                if staging_directory.exists():
                    shutil.rmtree(staging_directory)
        except Exception:
            pass
        with jobs_lock:
            if jobs[job_id]["status"] != "CANCELED":
                jobs[job_id].update(status="FAILED", stage="FAILED", failure_reason=str(exc)[-800:], updated_at=int(time.time() * 1000))
                _save_jobs_locked()


def _prep_job(job_id: str, body: PrepBody) -> None:
    with single_gpu_task("AVATAR_PREP", body.avatar_id):
        _prep_job_serial(job_id, body)


@app.get("/health")
def health() -> dict:
    required = [
        MUSETALK_HOME / "scripts" / "realtime_inference.py",
        MUSETALK_HOME / "models" / "musetalkV15" / "unet.pth",
        MUSETALK_HOME / "models" / "musetalkV15" / "musetalk.json",
        MUSETALK_HOME / "models" / "whisper" / "config.json",
        MUSETALK_HOME / "models" / "whisper" / "preprocessor_config.json",
        MUSETALK_HOME / "models" / "whisper" / "pytorch_model.bin",
        MUSETALK_HOME / "models" / "sd-vae" / "config.json",
        MUSETALK_HOME / "models" / "sd-vae" / "diffusion_pytorch_model.bin",
        MUSETALK_HOME / "models" / "dwpose" / "dw-ll_ucoco_384.pth",
        MUSETALK_HOME / "models" / "face-parse-bisent" / "79999_iter.pth",
        MUSETALK_HOME / "models" / "face-parse-bisent" / "resnet18-5c106cde.pth",
        MUSETALK_HOME / "musetalk" / "utils" / "face_detection" / "detection" / "sfd" / "s3fd.pth",
    ]
    missing = [str(path.relative_to(MUSETALK_HOME)) for path in required if not path.exists()]
    runtime_dependencies = [
        "cv2", "diffusers", "torchvision", "omegaconf", "transformers",
        "mmcv", "mmengine", "mmdet", "mmpose", "face_detection",
    ]
    missing_dependencies = [name for name in runtime_dependencies if importlib.util.find_spec(name) is None]
    gpu = gpu_runtime_status()
    cuda_ready = bool(gpu["cuda_ready"])
    avatars = []
    if RESULTS_DIR.exists():
        avatars = [directory.name for directory in RESULTS_DIR.iterdir() if directory.is_dir() and _avatar_is_prepared(directory.name)]
    with jobs_lock:
        queue_depth = sum(1 for job in jobs.values() if job["status"] in {"QUEUED", "PREPARING", "RENDERING"})
    functional_ready = not missing and not missing_dependencies
    ready = functional_ready
    runtime_mode = "cuda" if cuda_ready else "cpu"
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready, "accelerated": cuda_ready,
        "avatar": avatars[0] if avatars else "none", "avatars": avatars,
        "missing": missing, "missing_dependencies": missing_dependencies,
        "cuda_ready": cuda_ready,
        "runtime_mode": runtime_mode, "batch_size": BATCH_SIZE,
        "queue_depth": queue_depth,
        "gpu_profile": gpu["gpu_profile"], "gpu_total_mb": gpu["gpu_total_mb"],
        "gpu_free_mb": gpu["gpu_free_mb"], "safe_batch_ceiling": gpu["safe_batch_ceiling"],
        "active_gpu_task": gpu["active_task"], "queued_gpu_tasks": gpu["queued_gpu_tasks"],
    }


@app.get("/avatars")
def list_avatars() -> dict:
    return health()


@app.post("/avatars/prep")
def prep_avatar(body: PrepBody) -> dict:
    if not Path(body.video_path).exists():
        raise HTTPException(status_code=404, detail=f"video not found: {body.video_path}")
    try:
        avatar_directory = _avatar_dir(body.avatar_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not (MUSETALK_HOME / "data" / "audio" / "sun.wav").exists():
        raise HTTPException(status_code=500, detail="MuseTalk test audio is missing")
    with jobs_lock:
        for existing in jobs.values():
            if existing.get("kind") == "PREP" and existing.get("avatar_id") == body.avatar_id and existing.get("video_path") == body.video_path and existing.get("status") in {"QUEUED", "PREPARING"}:
                return dict(existing)
        job_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        jobs[job_id] = {"job_id": job_id, "kind": "PREP", "status": "QUEUED", "stage": "QUEUED", "progress": 0, "avatar_id": body.avatar_id, "video_path": body.video_path, "created_at": now, "updated_at": now}
        _save_jobs_locked()
        response = dict(jobs[job_id])
    threading.Thread(target=_prep_job, args=(job_id, body), daemon=True).start()
    return response


@app.get("/avatars/prep/{job_id}")
def get_prep_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("kind") != "PREP":
            raise HTTPException(status_code=404, detail="avatar preparation job not found")
        return dict(job)


@app.post("/avatars/prep/{job_id}/cancel")
def cancel_prep_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("kind") != "PREP":
            raise HTTPException(status_code=404, detail="avatar preparation job not found")
        if job.get("status") not in {"READY", "FAILED"}:
            job.update(status="CANCELED", stage="CANCELED", updated_at=int(time.time() * 1000))
            _save_jobs_locked()
        return dict(job)


def _render_job_serial(job_id: str, body: RenderBody) -> None:
    with jobs_lock:
        if jobs[job_id]["status"] == "CANCELED":
            return
        jobs[job_id].update(status="RENDERING", progress=10, updated_at=int(time.time() * 1000))
        _save_jobs_locked()
    try:
        if not Path(body.audio_path).exists():
            raise RuntimeError(f"audio not found: {body.audio_path}")
        if not _avatar_dir(body.avatar_id).exists():
            raise RuntimeError(f"avatar not prepared: {body.avatar_id}")
        reading_id = _safe_identifier(body.reading_id, "reading_id")
        config = _write_inference_config(
            body.avatar_id,
            str(_avatar_dir(body.avatar_id) / "full_imgs"),
            body.audio_path,
            prepare=False,
            output_key=reading_id,
        )
        _run_realtime_inference(config)
        candidates = [
            _video_output(body.avatar_id, body.reading_id),
            _avatar_dir(body.avatar_id) / "vid_output" / f"{reading_id}.mp4",
        ]
        video_path = next((str(candidate) for candidate in candidates if candidate.exists()), None)
        if not video_path:
            output_dir = _avatar_dir(body.avatar_id) / "vid_output"
            produced = sorted(output_dir.glob("*.mp4"), key=lambda path: path.stat().st_mtime, reverse=True) if output_dir.exists() else []
            video_path = str(produced[0]) if produced else None
        if not video_path:
            raise RuntimeError("render produced no video")
        with jobs_lock:
            if jobs[job_id]["status"] != "CANCELED":
                jobs[job_id].update(status="READY", progress=100, video_path=video_path, duration_ms=_wav_duration_ms(body.audio_path), updated_at=int(time.time() * 1000))
                _save_jobs_locked()
    except Exception as exc:
        with jobs_lock:
            if jobs[job_id]["status"] != "CANCELED":
                jobs[job_id].update(status="FAILED", failure_reason=str(exc)[-800:], updated_at=int(time.time() * 1000))
                _save_jobs_locked()


def _render_job(job_id: str, body: RenderBody) -> None:
    # Prep and render share one lane. Starting multiple MuseTalk inference
    # processes would exhaust VRAM and destabilize the OBS render loop.
    with single_gpu_task("AVATAR_RENDER", body.reading_id):
        _render_job_serial(job_id, body)


@app.post("/renders")
def create_render(body: RenderBody) -> dict:
    if not Path(body.audio_path).exists():
        raise HTTPException(status_code=404, detail=f"audio not found: {body.audio_path}")
    try:
        _safe_identifier(body.avatar_id, "avatar_id")
        _safe_identifier(body.reading_id, "reading_id")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not _avatar_is_prepared(body.avatar_id):
        raise HTTPException(status_code=409, detail=f"avatar not prepared: {body.avatar_id} (call /avatars/prep first)")
    job_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    with jobs_lock:
        jobs[job_id] = {"job_id": job_id, "status": "QUEUED", "progress": 0, "avatar_id": body.avatar_id, "reading_id": body.reading_id, "created_at": now, "updated_at": now}
        _save_jobs_locked()
        response = dict(jobs[job_id])
    threading.Thread(target=_render_job, args=(job_id, body), daemon=True).start()
    return response


@app.get("/renders/{job_id}")
def get_render(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="render job not found")
        return dict(job)


@app.post("/renders/{job_id}/cancel")
def cancel_render(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="render job not found")
        if job["status"] not in {"READY", "FAILED"}:
            job.update(status="CANCELED", updated_at=int(time.time() * 1000))
            _save_jobs_locked()
        return dict(job)


def main() -> None:
    parser = argparse.ArgumentParser(description="MuseTalk rendering service for meihua-live")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9898)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
