from __future__ import annotations

import argparse
import json
from pathlib import Path
from PIL import Image, ImageSequence

MAGENTA = (255, 0, 255)

def remove_magenta(img: Image.Image, threshold: int = 70) -> Image.Image:
    img = img.convert('RGBA')
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if abs(r - 255) <= threshold and g <= threshold and abs(b - 255) <= threshold:
                px[x, y] = (255, 0, 255, 0)
    return img

def bbox_alpha(img: Image.Image):
    alpha = img.getchannel('A')
    return alpha.getbbox()

def fit_to_cell(src: Image.Image, cell_w: int, cell_h: int, fit: float, align: str) -> Image.Image:
    canvas = Image.new('RGBA', (cell_w, cell_h), (0,0,0,0))
    box = bbox_alpha(src)
    if not box:
        return canvas
    cropped = src.crop(box)
    scale = min((cell_w * fit) / cropped.width, (cell_h * fit) / cropped.height)
    nw = max(1, int(round(cropped.width * scale)))
    nh = max(1, int(round(cropped.height * scale)))
    cropped = cropped.resize((nw, nh), Image.Resampling.NEAREST)
    x = (cell_w - nw) // 2
    if align == 'feet':
        y = cell_h - nh - max(2, int(cell_h * 0.04))
    elif align == 'bottom':
        y = cell_h - nh
    else:
        y = (cell_h - nh) // 2
    canvas.alpha_composite(cropped, (x, y))
    return canvas

def save_gif(frames, path: Path, duration: int):
    # Pillow keeps transparency most reliably when each frame is paletted with index 0 transparent.
    paletted = []
    for frame in frames:
        bg = Image.new('RGBA', frame.size, (255,0,255,0))
        bg.alpha_composite(frame)
        p = bg.convert('P', palette=Image.Palette.ADAPTIVE, colors=255)
        p.info['transparency'] = 0
        paletted.append(p)
    paletted[0].save(path, save_all=True, append_images=paletted[1:], duration=duration, loop=0, transparency=0, disposal=2)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, type=Path)
    ap.add_argument('--output-dir', required=True, type=Path)
    ap.add_argument('--name', required=True)
    ap.add_argument('--rows', type=int, default=1)
    ap.add_argument('--cols', type=int, required=True)
    ap.add_argument('--cell-width', type=int, default=64)
    ap.add_argument('--cell-height', type=int, default=96)
    ap.add_argument('--duration', type=int, default=166)
    ap.add_argument('--fit', type=float, default=0.86)
    ap.add_argument('--align', choices=['center','bottom','feet'], default='feet')
    ap.add_argument('--prompt-file', type=Path)
    args = ap.parse_args()

    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    raw = Image.open(args.input).convert('RGBA')
    raw.save(out / 'raw-sheet.png')
    clean = remove_magenta(raw)
    clean.save(out / 'raw-sheet-clean.png')

    raw_w, raw_h = clean.size
    src_cell_w = raw_w / args.cols
    src_cell_h = raw_h / args.rows
    frames = []
    qc = []
    for idx in range(args.rows * args.cols):
        row, col = divmod(idx, args.cols)
        left = int(round(col * src_cell_w))
        top = int(round(row * src_cell_h))
        right = int(round((col + 1) * src_cell_w))
        bottom = int(round((row + 1) * src_cell_h))
        cell = clean.crop((left, top, right, bottom))
        frame = fit_to_cell(cell, args.cell_width, args.cell_height, args.fit, args.align)
        frames.append(frame)
        frame.save(out / f'{args.name}-frame{idx+1}.png')
        qc.append({'frame': idx+1, 'source_box': [left, top, right, bottom], 'alpha_bbox': bbox_alpha(frame)})

    sheet = Image.new('RGBA', (args.cols * args.cell_width, args.rows * args.cell_height), (0,0,0,0))
    for idx, frame in enumerate(frames):
        row, col = divmod(idx, args.cols)
        sheet.alpha_composite(frame, (col * args.cell_width, row * args.cell_height))
    sheet.save(out / 'sheet-transparent.png')
    sheet.save(out / f'{args.name}.png')
    save_gif(frames, out / 'animation.gif', args.duration)
    save_gif(frames, out / f'{args.name}.gif', args.duration)

    meta = {
        'name': args.name,
        'rows': args.rows,
        'cols': args.cols,
        'cell_width': args.cell_width,
        'cell_height': args.cell_height,
        'sheet_size': [sheet.width, sheet.height],
        'duration_ms': args.duration,
        'source': str(args.input),
        'qc': qc,
    }
    if args.prompt_file and args.prompt_file.exists():
        (out / 'prompt-used.txt').write_text(args.prompt_file.read_text(encoding='utf-8'), encoding='utf-8')
        meta['prompt_file'] = str(args.prompt_file)
    (out / 'pipeline-meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
