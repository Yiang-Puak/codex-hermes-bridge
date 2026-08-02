#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request


IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def image_part(path, max_bytes):
    with open(path, "rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("image exceeds configured size limit")
    extension = os.path.splitext(path)[1].lower()
    mime = IMAGE_TYPES.get(extension)
    if not mime:
        raise ValueError(f"unsupported image extension: {extension}")
    encoded = base64.b64encode(data).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}}


def extract_text(data):
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text", item)) if isinstance(item, dict) else str(item) for item in content)
    return str(content)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--max-image-bytes", type=int, required=True)
    args = parser.parse_args()

    env = load_env(args.env_file)
    key = os.environ.get("DASHSCOPE_API_KEY") or env.get("DASHSCOPE_API_KEY")
    if not key:
        print("DASHSCOPE_API_KEY is not configured.", file=sys.stderr)
        return 2

    with open(args.manifest, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    with open(args.prompt, "r", encoding="utf-8") as handle:
        prompt = handle.read()

    content = [{
        "type": "text",
        "text": "Inspect every attached image directly. Return concrete visual evidence only.\n\n" + prompt,
    }]
    for image in manifest.get("images", []):
        content.append({"type": "text", "text": f"Image snapshot: {image['path']}"})
        content.append(image_part(image["path"], args.max_image_bytes))

    base_url = os.environ.get("DASHSCOPE_BASE_URL") or env.get("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1"
    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print(f"Vision API HTTP {exc.code}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Vision API request failed: {exc}", file=sys.stderr)
        return 1

    print(extract_text(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
