from __future__ import annotations

import argparse
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

SERVICE_ROOT = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get("KOKORO_MODEL_PATH", str(SERVICE_ROOT / "models" / "kokoro-v1.0.int8.onnx"))).resolve()
VOICES_PATH = Path(os.environ.get("KOKORO_VOICES_PATH", str(SERVICE_ROOT / "models" / "voices-v1.0.bin"))).resolve()
OUTPUT_ROOT = Path(os.environ.get("KOKORO_OUTPUT_DIR", str(SERVICE_ROOT / "output"))).resolve()
DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "af_heart")

app = FastAPI(title="Meihua Kokoro Local English Voice", version="1.0.0")
_engine = None
_engine_error: str | None = None
_engine_lock = threading.Lock()


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    voice: str = Field(default=DEFAULT_VOICE, min_length=2, max_length=80)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    locale: str = Field(default="en-US", max_length=20)
    output_path: str = Field(min_length=1, max_length=1_000)


def load_engine():
    global _engine, _engine_error
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
        if not MODEL_PATH.is_file():
            _engine_error = f"KOKORO_MODEL_MISSING:{MODEL_PATH}"
            raise RuntimeError(_engine_error)
        if not VOICES_PATH.is_file():
            _engine_error = f"KOKORO_VOICES_MISSING:{VOICES_PATH}"
            raise RuntimeError(_engine_error)
        try:
            from kokoro_onnx import Kokoro

            _engine = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
            _engine_error = None
            return _engine
        except Exception as exc:
            _engine_error = f"KOKORO_ENGINE_LOAD_FAILED:{exc}"
            raise RuntimeError(_engine_error) from exc


def allowed_output_path(raw: str) -> Path:
    target = Path(raw).expanduser().resolve()
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        target.relative_to(OUTPUT_ROOT)
    except ValueError as exc:
        raise ValueError("KOKORO_OUTPUT_PATH_NOT_ALLOWED") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def runtime_mode() -> str:
    try:
        import onnxruntime as ort

        return "cuda" if "CUDAExecutionProvider" in ort.get_available_providers() else "cpu"
    except Exception:
        return "unknown"


@app.get("/health")
def health():
    files_ready = MODEL_PATH.is_file() and VOICES_PATH.is_file()
    if files_ready and _engine is None and _engine_error is None:
        try:
            load_engine()
        except Exception:
            pass
    return {
        "ready": files_ready and _engine is not None and _engine_error is None,
        "model_ready": files_ready,
        "engine_loaded": _engine is not None,
        "engine_error": _engine_error,
        "runtime_mode": runtime_mode(),
        "model": MODEL_PATH.name,
        "default_voice": DEFAULT_VOICE,
        "voices": ["af_heart", "af_bella", "af_sarah", "bf_emma"],
    }


@app.post("/synthesize")
def synthesize(request: SynthesizeRequest):
    voice = request.voice.strip() or DEFAULT_VOICE
    if not voice.lower().startswith(("af_", "bf_")):
        raise HTTPException(status_code=400, detail="KOKORO_VOICE_UNSUPPORTED")
    locale = request.locale.strip().lower().replace("_", "-")
    if locale and locale not in {"en", "en-us", "en-gb"}:
        raise HTTPException(status_code=400, detail=f"KOKORO_LANG_UNSUPPORTED:{request.locale}")
    temp_path: Path | None = None
    try:
        output_path = allowed_output_path(request.output_path)
        engine = load_engine()
        lang = "en-gb" if voice.lower().startswith("bf_") or locale == "en-gb" else "en-us"
        started = time.perf_counter()
        samples, sample_rate = engine.create(request.text.strip(), voice=voice, speed=request.speed, lang=lang)
        temp_path = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
        import soundfile as sf

        sf.write(str(temp_path), samples, sample_rate, format="WAV", subtype="PCM_16")
        os.replace(temp_path, output_path)
        return {
            "ok": True,
            "voice": voice,
            "target_locale": "en-GB" if lang == "en-gb" else "en-US",
            "sample_rate": sample_rate,
            "wav_seconds": round(len(samples) / sample_rate, 3),
            "runtime_mode": runtime_mode(),
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "output_path": str(output_path),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass
        raise HTTPException(status_code=503, detail=str(exc)) from exc


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9890)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, workers=1)
