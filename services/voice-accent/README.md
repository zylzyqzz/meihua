# Local target-accent service

This service is the strict boundary for `COUNTRY_ACCENT` voice profiles. It
does not fall back to GPT-SoVITS. It requires a CUDA-visible Python runtime,
the pinned OpenVoice V2 assets, and the bundled `openvoice_worker.py` (or an
explicit `MEIHUA_ACCENT_ENGINE_COMMAND` override).

The command receives one JSON request on stdin and must write the requested
`output_path` as a RIFF/WAVE file. It should print optional JSON diagnostics to
stdout and exit with code 0 on success.

Required environment:

- `MEIHUA_ACCENT_HOME`: directory containing the pinned OpenVoice runtime and
  model assets.
- `MEIHUA_ACCENT_ENGINE_COMMAND`: wrapper executable/script that performs the
  OpenVoice inference.
- `MEIHUA_ACCENT_TIMEOUT_SECONDS`: optional per-synthesis timeout.

Without these assets the HTTP service intentionally reports degraded health and
returns `ACCENT_MODEL_MISSING`, `CUDA_REQUIRED_FOR_LIVE`, or
`ACCENT_ENGINE_NOT_READY`; this is safer than silently producing the
original-language GPT-SoVITS voice. OpenVoice V2's native target set includes
English, Spanish, French, Chinese, Japanese and Korean. The optional
Cantonese profile remains explicit and will report
`ACCENT_BASE_SPEAKER_MISSING` until a Cantonese MeloTTS base speaker is
installed.
