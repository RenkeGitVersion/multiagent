#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import Wav2Vec2FeatureExtractor

from profile_voice import (
    AgeGenderModel,
    LOCAL_MODEL_PATH,
    TARGET_SAMPLE_RATE,
    age_group,
    load_audio,
    make_segments,
)


def analyze(path: Path, seconds: float, feature_extractor, model) -> dict:
    started = time.perf_counter()
    audio = load_audio(path, seconds)
    ages = []
    gender_probs_list = []
    infer_started = time.perf_counter()
    with torch.inference_mode():
        for segment in make_segments(audio, seconds):
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

    return {
        "audioSeconds": round(len(audio) / TARGET_SAMPLE_RATE, 3),
        "ageYears": round(age_years, 1),
        "ageGroup": age_group(age_years),
        "gender": labels[best_index],
        "genderConfidence": round(float(gender_probs[best_index]), 4),
        "genderProbabilities": {
            label: round(float(prob), 4)
            for label, prob in zip(labels, gender_probs)
        },
        "segments": len(gender_probs_list),
        "inferenceSeconds": round(infer_seconds, 3),
        "totalSeconds": round(time.perf_counter() - started, 3),
    }


def main() -> None:
    model_path = os.environ.get("VOICE_PROFILE_MODEL_PATH", LOCAL_MODEL_PATH)
    load_started = time.perf_counter()
    feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(model_path, local_files_only=Path(model_path).exists())
    model = AgeGenderModel.from_pretrained(model_path, local_files_only=Path(model_path).exists())
    model.eval()
    print(json.dumps({"type": "ready", "loadSeconds": round(time.perf_counter() - load_started, 3)}), flush=True)

    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = analyze(Path(request["audio"]), float(request.get("seconds", 3.0)), feature_extractor, model)
            print(json.dumps({"id": request.get("id"), "ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id") if "request" in locals() else None, "ok": False, "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
