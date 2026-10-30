#!/usr/bin/env python3
"""Build the widget's generic illustrations and synthesized notification tones.

Run with Python, Pillow and FFmpeg. Runtime installation does not need these tools.
All source paths are relative to this repository; no local installation media is read.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RATE = 24000
TONES = {
    'Ya1.mp3': (523.25, 0.16),
    'Ya2.mp3': (659.25, 0.16),
    'D1.mp3': (783.99, 0.14),
    'D2.mp3': (587.33, 0.14),
    'minecraft-exp-orb.wav': (1046.50, 0.20),
    'task-end-a.wav': (783.99, 0.24),
    'cost-default.wav': (659.25, 0.14),
    'ask-default.wav': (523.25, 0.18),
    'approve-default.wav': (880.00, 0.18),
}


def clean_image(source, size=None):
    with Image.open(source) as original:
        image = original.convert('RGBA')
        if size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        result = Image.new('RGBA', image.size)
        result.paste(image)
        return result


def save_gif(source, target):
    image = clean_image(source)
    palette = image.convert('RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette.putpalette((palette.getpalette() or [])[:765] + [0, 0, 0])
    mask = image.getchannel('A').point(lambda value: 255 if value < 128 else 0)
    palette.paste(255, mask=mask)
    palette.save(target, format='GIF', transparency=255, optimize=False)


def tone_wav(target, frequency, seconds):
    count = round(RATE * seconds)
    frames = bytearray()
    for index in range(count):
        envelope = math.sin(math.pi * index / max(1, count - 1)) ** 2
        sample = round(32767 * 0.12 * envelope * math.sin(2 * math.pi * frequency * index / RATE))
        frames.extend(struct.pack('<h', sample))
    with wave.open(str(target), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(frames)


def generate(destination):
    assets = destination / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    portrait = ROOT / 'assets' / 'portrait.png'
    for name in ['DSniang1.png', 'DSniang02.png']:
        clean_image(portrait, (610, 610)).save(assets / name, format='PNG')
    clean_image(ROOT / 'assets' / 'background.png').save(assets / 'DSH2.png', format='PNG')
    clean_image(ROOT / 'assets' / 'icon.png').save(destination / 'icon.png', format='PNG')
    for name, sticker in [('rua.gif', 'warm.png'), ('bubble-petpet.gif', 'warm.png'), ('bubble-money1.gif', 'joyful.png')]:
        save_gif(ROOT / 'assets' / 'stickers' / sticker, assets / name)
    encoder = shutil.which('ffmpeg')
    if not encoder:
        raise RuntimeError('FFmpeg is required to encode the bundled MP3 notification tones.')
    with tempfile.TemporaryDirectory(prefix='widget-assets-') as temporary:
        for name, (frequency, seconds) in TONES.items():
            target = assets / name
            if target.suffix == '.wav':
                tone_wav(target, frequency, seconds)
            else:
                source = Path(temporary) / (target.stem + '.wav')
                tone_wav(source, frequency, seconds)
                subprocess.run([
                    encoder, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', str(source), '-map_metadata', '-1', '-c:a', 'libmp3lame',
                    '-b:a', '96k', '-id3v2_version', '0', '-write_id3v1', '0',
                    '-write_xing', '0', '-bitexact', str(target),
                ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    files = [destination / 'icon.png'] + [assets / name for name in ['DSniang1.png', 'DSniang02.png', 'DSH2.png', 'rua.gif', 'bubble-petpet.gif', 'bubble-money1.gif', *TONES]]
    return [{'file': str(path.relative_to(destination)), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT / 'vendor' / 'widget')
    args = parser.parse_args()
    print(json.dumps({'generated': generate(args.destination)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
