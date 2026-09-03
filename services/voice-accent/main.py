"""Local target-locale voice service boundary.

The control service owns profile metadata and the final audio directory. This
process owns the CUDA OpenVoice runtime. A real engine wrapper is invoked via
MEIHUA_ACCENT_ENGINE_COMMAND and receives one JSON request on stdin; it must
write the requested WAV and return JSON with ``ok: true``.

Keeping this boundary explicit prevents GPT-SoVITS from being presented as a
country-accent engine when the OpenVoice model is not installed.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

ACCENT_HOME = Path(os.environ.get("MEIHUA_ACCENT_HOME", "E:/meihua/OpenVoice"))
ENGINE_COMMAND = os.environ.get("MEIHUA_ACCENT_ENGINE_COMMAND", "").strip()
WORKER_PATH = Path(__file__).resolve().with_name("openvoice_worker.py")
CHECKPOINT_ROOT = ACCENT_HOME / os.environ.get("MEIHUA_ACCENT_CHECKPOINT_DIR", "checkpoints_v2")
SUPPORTED_TARGETS = {
    "zh-CN": "zh-cn-standard",
    "yue-HK": "yue-hk",
    "en-US": "en-us",
    "en-GB": "en-gb",
    "ja-JP": "ja-jp",
    "ko-KR": "ko-kr",
    "es-ES": "es-es",
    "fr-FR": "fr-fr",
}

app = FastAPI(title="meihua-voice-accent-service")


class SynthesisBody(BaseModel):
    reference_audio_path: str
    reference_text: str = ""
    reference_language: str = ""
    voice_id: str
    text: str
    source_language: str = ""
    target_locale: str
    target_country: str = ""
    accent_profile_id: str
    speed: float = 1.0
    output_path: str


def _cuda_ready() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _engine_command() -> list[str]:
    if ENGINE_COMMAND:
        return shlex.split(ENGINE_COMMAND, posix=False)
    if WORKER_PATH.exists():
        return [sys.executable, "-u", str(WORKER_PATH)]
    return []


def _model_assets_ready() -> bool:
    required = (
        CHECKPOINT_ROOT / "converter" / "config.json",
        CHECKPOINT_ROOT / "converter" / "checkpoint.pth",
        CHECKPOINT_ROOT / "base_speakers" / "ses",
    )
    return all(path.exists() for path in required)


def _wav_valid(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
            return len(header) == 12 and header[0:4] == b"RIFF" and header[8:12] == b"WAVE"
    except Exception:
        return False


def _wav_duration_ms(path: Path) -> int:
    try:
        import wave
        with wave.open(str(path), "rb") as handle:
            return int(handle.getnframes() / max(1, handle.getframerate()) * 1000)
    except Exception:
        return 0


def _health_payload() -> dict:
    command = _engine_command()
    modules = {name: importlib.util.find_spec(name) is not None for name in ("torch", "openvoice", "melo")}
    cuda_ready = _cuda_ready()
    model_ready = _model_assets_ready()
    ready = bool(command and all(modules.values()) and cuda_ready and model_ready)
    missing = []
    if not command:
        missing.append("openvoice_worker.py")
    missing.extend(name for name, present in modules.items() if not present)
    if not cuda_ready:
        missing.append("CUDA")
    if not ACCENT_HOME.exists():
        missing.append(str(ACCENT_HOME))
    if not model_ready:
        missing.append(f"OpenVoice checkpoints: {CHECKPOINT_ROOT}")
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready,
        "engine": "openvoice-v2",
        "cuda_ready": cuda_ready,
        "runtime_mode": "cuda" if cuda_ready else "cpu",
        "model_ready": model_ready,
        "checkpoint_root": str(CHECKPOINT_ROOT),
        "modules": modules,
        "supported_targets": sorted(SUPPORTED_TARGETS),
        "missing": missing,
    }


@app.get("/health")
def health() -> dict:
    return _health_payload()


@app.post("/synthesize")
def synthesize(body: SynthesisBody) -> dict:
    if body.target_locale not in SUPPORTED_TARGETS:
        raise HTTPException(status_code=422, detail=f"VOICE_TARGET_UNSUPPORTED:{body.target_locale}")
    if body.accent_profile_id != SUPPORTED_TARGETS[body.target_locale]:
        raise HTTPException(status_code=422, detail="VOICE_ACCENT_PROFILE_LOCALE_MISMATCH")
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="VOICE_ACCENT_TEXT_REQUIRED")
    reference = Path(body.reference_audio_path)
    output = Path(body.output_path)
    if not reference.exists():
        raise HTTPException(status_code=404, detail="VOICE_REFERENCE_AUDIO_MISSING")
    status = _health_payload()
    if not status["ready"]:
        missing = status["missing"]
        if "CUDA" in missing:
            code = "CUDA_REQUIRED_FOR_LIVE"
        elif not status["model_ready"] or str(ACCENT_HOME) in missing:
            code = "ACCENT_MODEL_MISSING"
        else:
            code = "ACCENT_ENGINE_NOT_READY"
        raise HTTPException(status_code=503, detail=code + ":" + ",".join(missing))
    output.parent.mkdir(parents=True, exist_ok=True)
    request = body.model_dump()
    request["target_accent"] = body.accent_profile_id
    started = time.time()
    try:
        completed = subprocess.run(
            _engine_command(), input=json.dumps(request, ensure_ascii=False),
            text=True, capture_output=True, timeout=max(60, int(os.environ.get("MEIHUA_ACCENT_TIMEOUT_SECONDS", "600"))),
            check=False, cwd=str(ACCENT_HOME), env=dict(os.environ),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="ACCENT_ENGINE_TIMEOUT") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "ACCENT_ENGINE_FAILED")[-800:]
        raise HTTPException(status_code=502, detail=f"ACCENT_ENGINE_FAILED:{detail}")
    if not output.exists() or not _wav_valid(output):
        raise HTTPException(status_code=502, detail="ACCENT_OUTPUT_NOT_WAV")
    return {
        "ok": True, "output_path": str(output), "target_locale": body.target_locale,
        "accent_profile_id": body.accent_profile_id, "engine": "openvoice-v2",
        "duration_ms": _wav_duration_ms(output), "elapsed_ms": int((time.time() - started) * 1000),
        "quality": {"wav_valid": True, "reference_present": True, "cuda": True},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Meihua local CUDA target-accent service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9899)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
