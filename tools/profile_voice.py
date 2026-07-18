#!/usr/bin/env python3
import argparse
import json
import os
import sys
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
    if seconds:
        audio = audio[: int(TARGET_SAMPLE_RATE * seconds)]
    return audio.astype(np.float32)


def age_group(age_years: float) -> str:
    if age_years < 13:
        return "child"
    if age_years < 18:
        return "teen"
    if age_years < 60:
        return "adult"
    return "senior"


def load_model(model_path: str):
    started = time.perf_counter()
    local_files_only = Path(model_path).exists()
    feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(model_path, local_files_only=local_files_only)
    model = AgeGenderModel.from_pretrained(model_path, local_files_only=local_files_only)
    model.eval()
    return feature_extractor, model, time.perf_counter() - started


def analyze_audio(path: Path, seconds: float | None, feature_extractor, model, model_path: str, load_seconds: float) -> dict:
    audio = load_audio(path, seconds)
    processed = feature_extractor(audio, sampling_rate=TARGET_SAMPLE_RATE)
    input_values = torch.from_numpy(processed["input_values"][0]).reshape(1, -1)

    infer_started = time.perf_counter()
    with torch.inference_mode():
        _, logits_age, logits_gender = model(input_values)
    infer_seconds = time.perf_counter() - infer_started

    age_years = float(logits_age[0][0].item() * 100)
    gender_probs = logits_gender[0].detach().cpu().numpy()
    labels = ["female", "male", "child"]
    best_index = int(np.argmax(gender_probs))

    return {
        "model": model_path,
        "audioSeconds": round(len(audio) / TARGET_SAMPLE_RATE, 3),
        "ageYears": round(age_years, 1),
        "ageGroup": age_group(age_years),
        "gender": labels[best_index],
        "genderConfidence": round(float(gender_probs[best_index]), 4),
        "genderProbabilities": {
            label: round(float(prob), 4)
            for label, prob in zip(labels, gender_probs)
        },
        "loadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(infer_seconds, 3),
        "totalSeconds": round(load_seconds + infer_seconds, 3)
    }


def serve(model_path: str, default_seconds: float) -> None:
    started = time.perf_counter()
    feature_extractor, model, load_seconds = load_model(model_path)
    print(json.dumps({
        "type": "ready",
        "model": model_path,
        "loadSeconds": round(load_seconds, 3),
        "totalSeconds": round(time.perf_counter() - started, 3)
    }, ensure_ascii=False), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request.get("id")
            audio = Path(request["audio"])
            seconds = float(request.get("seconds", default_seconds))
            result = analyze_audio(audio, seconds, feature_extractor, model, model_path, load_seconds)
            result["id"] = request_id
            result["type"] = "result"
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({
                "id": locals().get("request", {}).get("id") if "request" in locals() else None,
                "type": "error",
                "error": str(error)
            }, ensure_ascii=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate speaker age/gender with audeering 6-layer model.")
    parser.add_argument("audio", type=Path, nargs="?", help="16 kHz mono/stereo wav file")
    parser.add_argument("--seconds", type=float, default=4.0, help="Only use the first N seconds")
    parser.add_argument("--model-path", default=os.environ.get("VOICE_PROFILE_MODEL_PATH", LOCAL_MODEL_PATH), help="HF model id or a local snapshot path")
    parser.add_argument("--serve", action="store_true", help="Keep model loaded and process JSONL requests from stdin")
    args = parser.parse_args()

    if args.serve:
        serve(args.model_path, args.seconds)
        return

    if not args.audio:
        raise SystemExit("audio path is required unless --serve is used")

    started = time.perf_counter()
    feature_extractor, model, load_seconds = load_model(args.model_path)
    result = analyze_audio(args.audio, args.seconds, feature_extractor, model, args.model_path, load_seconds)
    result["totalSeconds"] = round(time.perf_counter() - started, 3)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
