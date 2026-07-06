#!/usr/bin/env python3
import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch


MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
TARGET_SAMPLE_RATE = 16000


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    return audio.astype(np.float32), int(sample_rate)


def analyze_quality(audio: np.ndarray, sample_rate: int) -> dict:
    duration = len(audio) / sample_rate if sample_rate else 0
    abs_audio = np.abs(audio)
    peak = float(np.max(abs_audio)) if len(abs_audio) else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
    clipping_ratio = float(np.mean(abs_audio >= 0.99)) if len(abs_audio) else 0.0
    silence_threshold = max(0.01, rms * 0.35)
    silence_ratio = float(np.mean(abs_audio < silence_threshold)) if len(abs_audio) else 1.0
    speech_seconds = duration * (1 - silence_ratio)

    reasons: list[str] = []
    if sample_rate != TARGET_SAMPLE_RATE:
        reasons.append("invalid_sample_rate")
    if duration < env_float("SPEAKER_MIN_DURATION_SECONDS", 1.5):
        reasons.append("too_short")
    if speech_seconds < env_float("SPEAKER_MIN_SPEECH_SECONDS", 1.0):
        reasons.append("no_speech_detected")
    if rms < env_float("SPEAKER_MIN_RMS", 0.005):
        reasons.append("too_quiet")
    if clipping_ratio > env_float("SPEAKER_MAX_CLIPPING_RATIO", 0.01):
        reasons.append("clipped")
    if silence_ratio > env_float("SPEAKER_MAX_SILENCE_RATIO", 0.65):
        reasons.append("too_much_silence")

    return {
        "ok": len(reasons) == 0,
        "durationSeconds": round(duration, 3),
        "speechSeconds": round(speech_seconds, 3),
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "clippingRatio": round(clipping_ratio, 6),
        "silenceRatio": round(silence_ratio, 6),
        "reasons": reasons,
    }


def l2_normalize(values: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(values)
    if norm <= 0:
        return values
    return values / norm


def extract_embedding(audio: np.ndarray, model_path: str) -> tuple[list[float], int]:
    from speechbrain.inference.speaker import EncoderClassifier

    classifier = EncoderClassifier.from_hparams(
        source=model_path,
        savedir=os.environ.get("SPEAKER_MODEL_SAVEDIR", "pretrained_models/spkrec-ecapa-voxceleb"),
    )
    signal = torch.from_numpy(audio).unsqueeze(0)
    with torch.inference_mode():
        embedding = classifier.encode_batch(signal).squeeze().detach().cpu().numpy().astype(np.float32)
    embedding = l2_normalize(embedding)
    return [round(float(item), 8) for item in embedding.tolist()], int(embedding.shape[0])


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract speaker embedding and quality metrics from 16 kHz WAV.")
    parser.add_argument("audio", type=Path, help="16 kHz mono/stereo wav file")
    parser.add_argument("--model-path", default=os.environ.get("SPEAKER_MODEL_PATH", MODEL_ID))
    args = parser.parse_args()

    started = time.perf_counter()
    audio, sample_rate = load_audio(args.audio)
    quality = analyze_quality(audio, sample_rate)
    embedding: list[float] = []
    embedding_dim = 0
    inference_seconds = 0.0
    error = None

    if quality["ok"]:
        infer_started = time.perf_counter()
        try:
            embedding, embedding_dim = extract_embedding(audio, args.model_path)
        except Exception as exc:
            quality["ok"] = False
            quality["reasons"].append("model_failed")
            error = str(exc)
        inference_seconds = time.perf_counter() - infer_started

    payload = {
        "source": "speaker" if quality["ok"] else "failed",
        "model": args.model_path,
        "embeddingDim": embedding_dim,
        "embedding": embedding,
        "quality": quality,
        "inferenceSeconds": round(inference_seconds, 3),
        "totalSeconds": round(time.perf_counter() - started, 3),
    }
    if error:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
