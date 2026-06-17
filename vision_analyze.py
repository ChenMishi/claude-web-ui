#!/usr/bin/env python3
"""本地图片分析 — 使用 Florence-2 同时做画面描述和 OCR。
用法: python3 vision_analyze.py <image_path>
输出: JSON { ok: true, caption: "...", ocr: "...", error?: "..." }
"""

import sys
import json
import os

# 使用 HF 镜像加速下载
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
from PIL import Image


# ── 模型缓存到项目目录下 ──
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".vision_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

MODEL_ID = "microsoft/Florence-2-base"


def load_model():
    """延迟加载，首次调用时下载模型 (~300MB)"""
    from transformers import AutoProcessor, AutoModelForCausalLM
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, trust_remote_code=True, cache_dir=CACHE_DIR
    ).to("cpu").eval()
    processor = AutoProcessor.from_pretrained(
        MODEL_ID, trust_remote_code=True, cache_dir=CACHE_DIR
    )
    return model, processor


def analyze(image_path):
    model, processor = load_model()
    image = Image.open(image_path).convert("RGB")

    results = {}

    # ── 任务1: 详细画面描述 ──
    try:
        inputs = processor(
            text="<DETAILED_CAPTION>", images=image, return_tensors="pt"
        )
        generated_ids = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=512,
            do_sample=False,
        )
        results["caption"] = processor.batch_decode(
            generated_ids, skip_special_tokens=True
        )[0].strip()
    except Exception as e:
        results["caption"] = f"(描述生成失败: {e})"

    # ── 任务2: OCR 文字识别 ──
    try:
        inputs = processor(
            text="<OCR>", images=image, return_tensors="pt"
        )
        generated_ids = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=512,
            do_sample=False,
        )
        results["ocr"] = processor.batch_decode(
            generated_ids, skip_special_tokens=True
        )[0].strip()
    except Exception as e:
        results["ocr"] = f"(OCR 失败: {e})"

    return results


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: vision_analyze.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.isfile(image_path):
        print(json.dumps({"ok": False, "error": f"文件不存在: {image_path}"}))
        sys.exit(1)

    try:
        results = analyze(image_path)
        results["ok"] = True
        print(json.dumps(results, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
