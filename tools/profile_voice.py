#!/usr/bin/env python3
import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
from transformers import Wav2Vec2FeatureExtractor
from transformers.models.wav2vec2.modeling_wav2vec2 import Wav2Vec2Model, Wav2Vec2PreTrainedModel


MODEL_ID = "audeering/wav2vec2-large-robust-6-ft-age-gender"
TARGET_SAMPLE_RATE = 16000
LOCAL_MODEL_PATH = "/Users/renke/.cache/huggingface/hub/models--audeering--wav2vec2-large-robust-6-ft-age-gender/snapshots/a681b720dafd12b9dd7b6d13fb437c7b6b197fd3"


class ModelHead(nn.Module):
    def __init__(self, config, num_labels: int):
        super().__init__()
        self.dense = nn.Linear(config.hidden_size, config.hidden_size)
        self.dropout = nn.Dropout(config.final_dropout)
        self.out_proj = nn.Linear(config.hidden_size, num_labels)

    def forward(self, features):
        x = self.dropout(features)
        x = self.dense(x)
        x = torch.tanh(x)
        x = self.dropout(x)
        return self.out_proj(x)


class AgeGenderModel(Wav2Vec2PreTrainedModel):
    all_tied_weights_keys: dict = {}

    def __init__(self, config):
        super().__init__(config)
        self.wav2vec2 = Wav2Vec2Model(config)
        self.age = ModelHead(config, 1)
        self.gender = ModelHead(config, 3)
        self.init_weights()

    def forward(self, input_values):
        outputs = self.wav2vec2(input_values)
        hidden_states = torch.mean(outputs[0], dim=1)
        logits_age = self.age(hidden_states)
        logits_gender = torch.softmax(self.gender(hidden_states), dim=1)
        return hidden_states, logits_age, logits_gender


def load_audio(path: Path, seconds: float | None) -> np.ndarray:
    audio, sample_rate = sf.read(path)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sample_rate != TARGET_SAMPLE_RATE:
        raise ValueError(f"Expected {TARGET_SAMPLE_RATE} Hz audio, got {sample_rate} Hz. Convert before running.")
    audio = audio.astype(np.float32)
    audio = trim_silence(audio)
    if seconds:
        audio = audio[: int(TARGET_SAMPLE_RATE * seconds)]
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0:
        audio = audio / peak * 0.95
    return audio


def trim_silence(audio: np.ndarray) -> np.ndarray:
    if audio.size == 0:
        return audio
    threshold = max(float(np.max(np.abs(audio))) * 0.08, 0.01)
    speech_indices = np.flatnonzero(np.abs(audio) > threshold)
    if speech_indices.size == 0:
        return audio
    pad = int(TARGET_SAMPLE_RATE * 0.12)
    start = max(int(speech_indices[0]) - pad, 0)
    end = min(int(speech_indices[-1]) + pad, audio.size)
    return audio[start:end]


def make_segments(audio: np.ndarray, seconds: float | None) -> list[np.ndarray]:
    if audio.size == 0:
        return [audio]
    max_samples = int(TARGET_SAMPLE_RATE * seconds) if seconds else audio.size
    window_samples = min(audio.size, max(int(TARGET_SAMPLE_RATE * 1.2), min(max_samples, int(TARGET_SAMPLE_RATE * 2.2))))
    if audio.size <= window_samples:
        return [audio[:window_samples]]
    starts = [0, max((audio.size - window_samples) // 2, 0), audio.size - window_samples]
    unique_starts = []
    for start in starts:
        if start not in unique_starts:
            unique_starts.append(start)
    return [audio[start:start + window_samples] for start in unique_starts]


def age_group(age_years: float) -> str:
    if age_years < 13:
        return "child"
    if age_years < 18:
        return "teen"
    if age_years < 60:
        return "adult"
    return "senior"


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate speaker age/gender with audeering 6-layer model.")
    parser.add_argument("audio", type=Path, help="16 kHz mono/stereo wav file")
    parser.add_argument("--seconds", type=float, default=4.0, help="Only use the first N seconds")
    parser.add_argument("--model-path", default=os.environ.get("VOICE_PROFILE_MODEL_PATH", LOCAL_MODEL_PATH), help="HF model id or a local snapshot path")
    args = parser.parse_args()

    started = time.perf_counter()
    feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(args.model_path, local_files_only=Path(args.model_path).exists())
    model = AgeGenderModel.from_pretrained(args.model_path, local_files_only=Path(args.model_path).exists())
    model.eval()
    load_seconds = time.perf_counter() - started

    infer_started = time.perf_counter()
    audio = load_audio(args.audio, args.seconds)
    ages = []
    gender_probs_list = []
    with torch.inference_mode():
        for segment in make_segments(audio, args.seconds):
            processed = feature_extractor(segment, sampling_rate=TARGET_SAMPLE_RATE)
            input_values = torch.from_numpy(processed["input_values"][0]).reshape(1, -1)
            _, logits_age, logits_gender = model(input_values)
            ages.append(float(logits_age[0][0].item() * 100))
            gender_probs_list.append(logits_gender[0].detach().cpu().numpy())
    infer_seconds = time.perf_counter() - infer_started

    age_years = float(np.median(np.array(ages))) if ages else 0.0
    gender_probs = np.mean(np.stack(gender_probs_list), axis=0) if gender_probs_list else np.array([0.0, 0.0, 0.0])
    labels = ["female", "male", "child"]
    best_index = int(np.argmax(gender_probs))

    print(json.dumps({
        "model": args.model_path,
        "audioSeconds": round(len(audio) / TARGET_SAMPLE_RATE, 3),
        "ageYears": round(age_years, 1),
        "ageGroup": age_group(age_years),
        "gender": labels[best_index],
        "genderConfidence": round(float(gender_probs[best_index]), 4),
        "segments": len(gender_probs_list),
        "genderProbabilities": {
            label: round(float(prob), 4)
            for label, prob in zip(labels, gender_probs)
        },
        "loadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(infer_seconds, 3),
        "totalSeconds": round(load_seconds + infer_seconds, 3)
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
