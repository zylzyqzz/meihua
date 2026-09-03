"""OpenVoice V2 + MeloTTS worker used by the local accent service.

The HTTP process deliberately does not import the heavy inference stack.  This
worker is started only after the service has confirmed CUDA, Python modules and
the pinned ``checkpoints_v2`` assets are available.  It accepts one JSON object
on stdin and writes the requested WAV path.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


TARGETS = {
    "zh-CN": {"melo": "ZH", "speaker": ("zh", "zh-cn")},
    "yue-HK": {"melo": "YUE", "speaker": ("yue-hk", "yue")},
    "en-US": {"melo": "EN_NEWEST", "speaker": ("en-us",)},
    "en-GB": {"melo": "EN_NEWEST", "speaker": ("en-gb",)},
    "ja-JP": {"melo": "JP", "speaker": ("jp", "ja")},
    "ko-KR": {"melo": "KR", "speaker": ("kr", "ko")},
    "es-ES": {"melo": "ES", "speaker": ("es", "es-es")},
    "fr-FR": {"melo": "FR", "speaker": ("fr", "fr-fr")},
}


def _checkpoint_root() -> Path:
    home = Path(os.environ.get("MEIHUA_ACCENT_HOME", "E:/meihua/OpenVoice"))
    return home / os.environ.get("MEIHUA_ACCENT_CHECKPOINT_DIR", "checkpoints_v2")


def _normalise(value: str) -> str:
    return value.lower().replace("_", "-").strip()


def _select_speaker(speaker_ids: dict, target_locale: str) -> tuple[int, str]:
    aliases = {_normalise(value) for value in TARGETS[target_locale]["speaker"]}
    for key, speaker_id in speaker_ids.items():
        if _normalise(str(key)) in aliases:
            return int(speaker_id), _normalise(str(key))
    raise RuntimeError(f"ACCENT_BASE_SPEAKER_MISSING:{target_locale}")


def _synthesise(request: dict) -> dict:
    import torch
    from melo.api import TTS
    from openvoice import se_extractor
    from openvoice.api import ToneColorConverter

    target_locale = str(request["target_locale"])
    if target_locale not in TARGETS:
        raise RuntimeError(f"VOICE_TARGET_UNSUPPORTED:{target_locale}")
    checkpoint_root = _checkpoint_root()
    converter_root = checkpoint_root / "converter"
    converter = ToneColorConverter(str(converter_root / "config.json"), device="cuda:0")
    converter.load_ckpt(str(converter_root / "checkpoint.pth"))

    reference = Path(request["reference_audio_path"])
    output = Path(request["output_path"])
    output.parent.mkdir(parents=True, exist_ok=True)
    processed = output.parent / ".openvoice-se"
    processed.mkdir(parents=True, exist_ok=True)
    target_se, _ = se_extractor.get_se(str(reference), converter, target_dir=str(processed), vad=True)

    model = TTS(language=TARGETS[target_locale]["melo"], device="cuda:0")
    speaker_id, speaker_key = _select_speaker(model.hps.data.spk2id, target_locale)
    source_se_path = checkpoint_root / "base_speakers" / "ses" / f"{speaker_key}.pth"
    if not source_se_path.exists():
        raise RuntimeError(f"ACCENT_SPEAKER_EMBEDDING_MISSING:{source_se_path.name}")
    source_se = torch.load(str(source_se_path), map_location="cuda:0")

    with tempfile.TemporaryDirectory(prefix="meihua-openvoice-") as temp_dir:
        source_audio = Path(temp_dir) / "source.wav"
        model.tts_to_file(
            str(request["text"]), speaker_id, str(source_audio),
            speed=float(request.get("speed", 1.0)),
        )
        converter.convert(
            audio_src_path=str(source_audio),
            src_se=source_se,
            tgt_se=target_se,
            output_path=str(output),
            message="@MyShell",
        )
    return {"speaker": speaker_key, "target_locale": target_locale}


def main() -> None:
    raw = sys.stdin.read()
    request = json.loads(raw)
    result = _synthesise(request)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
