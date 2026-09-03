"""Offline reference-audio transcription for the one-package voice clone flow.

The script uses the Whisper Tiny checkpoint bundled with MeihuaStudio. No model
is downloaded at runtime. It prints one JSON object on the last stdout line so
the Node orchestrator can consume it without importing Python packages itself.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

import torch
import whisper


LANGUAGES = {"zh", "yue", "en", "ja", "ko"}


def configure_ffmpeg() -> str:
    """Locate the bundled FFmpeg without relying on the launcher's PATH."""
    script_path = Path(__file__).resolve()
    candidates = []
    configured = os.environ.get("MEIHUA_FFMPEG_PATH", "").strip()
    if configured:
        candidates.append(Path(configured))
    # Source tree: <project>/services/voice-asr/transcribe.py
    # Bundle tree: <bundle>/app/services/voice-asr/transcribe.py
    candidates.append(script_path.parents[2] / "tools" / "ffmpeg")
    for candidate in candidates:
        # The Node control service accepts either the ffmpeg folder or the
        # executable itself.  Match that behaviour here so a bundle launched
        # by Electron and one launched by PowerShell cannot disagree.
        directory = candidate.parent if candidate.is_file() else candidate
        executable = candidate if candidate.is_file() else directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if executable.is_file():
            os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
            return str(executable)
    existing = shutil.which("ffmpeg")
    if existing:
        return existing
    raise FileNotFoundError("bundled FFmpeg was not found")


def transcribe(audio_path: str, model_path: str, language: str) -> dict[str, object]:
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"audio file does not exist: {audio_path}")
    if not os.path.isfile(model_path):
        raise FileNotFoundError(f"Whisper checkpoint is missing: {model_path}")

    configure_ffmpeg()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = whisper.load_model(model_path, device=device)
    requested_language = None if language == "auto" else language
    result = model.transcribe(
        audio_path,
        language=requested_language,
        task="transcribe",
        fp16=device == "cuda",
        beam_size=5,
        condition_on_previous_text=False,
        verbose=False,
    )
    text = str(result.get("text", ""))
    text = " ".join(text.replace("\u3000", " ").split()).strip()
    if len(text) < 2:
        raise ValueError("Whisper did not detect usable speech")
    detected_language = str(result.get("language") or language)
    return {"ok": True, "text": text, "language": detected_language, "requested_language": language, "device": device}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", choices=("auto", *tuple(sorted(LANGUAGES))), default="auto")
    args = parser.parse_args()
    try:
        result = transcribe(args.audio, args.model, args.language)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # The caller needs a stable, truthful failure payload.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
