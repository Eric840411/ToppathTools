"""Generate an image with OpenAI DALL-E 3."""

import argparse
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen

from openai import OpenAI


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate an image with OpenAI DALL-E 3."
    )
    parser.add_argument(
        "prompt",
        nargs="+",
        help="Text prompt used to generate the image.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    prompt = " ".join(args.prompt).strip()

    if not prompt:
        print("Prompt must not be empty.", file=sys.stderr)
        return 1

    client = OpenAI()
    response = client.images.generate(
        model="dall-e-3",
        prompt=prompt,
        size="1024x1024",
        response_format="url",
    )

    image_url = response.data[0].url
    if not image_url:
        print("Image generation succeeded but no image URL was returned.", file=sys.stderr)
        return 1

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path.cwd() / f"generated_image_{timestamp}.png"

    with urlopen(image_url) as remote_file:
        output_path.write_bytes(remote_file.read())

    print(f"Image URL: {image_url}")
    print(f"Saved to: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
