#!/usr/bin/env bash
# Erzeugt synthetische Test-Fixtures für die Compression-Engine.
# Reproduzierbar: gleiche Pixel-/Frame-Werte bei jedem Lauf.
# Nutzt AUSSCHLIESSLICH sharp (Node) und ffmpeg — kein ImageMagick erforderlich.
set -euo pipefail

cd "$(dirname "$0")"

# pnpm exec ändert cwd auf das package-Verzeichnis — wir merken uns
# test-fixtures/ in einer Env-Variable, die vom Node-Skript via process.env.FIXTURES_DIR
# wieder aufgegriffen wird.
export FIXTURES_DIR="$PWD"

# Bilder via sharp — pnpm exec resolved sharp aus packages/compression/node_modules
pnpm --filter @mediacompressor/compression exec node -e "
const sharp = require('sharp');

(async () => {
  // 256x256 Schachbrett-Pattern via raw RGB-Buffer
  const w = 256, h = 256;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = ((x >> 5) + (y >> 5)) & 1 ? 255 : 0;
      const i = (y * w + x) * 3;
      buf[i] = buf[i + 1] = buf[i + 2] = c;
    }
  }
  const dir = process.env.FIXTURES_DIR;
  const base = sharp(buf, { raw: { width: w, height: h, channels: 3 } });

  await base.clone().png().toFile(dir + '/tiny.png');
  await base.clone().jpeg({ quality: 80 }).toFile(dir + '/tiny.jpg');
  await base.clone().webp().toFile(dir + '/tiny.webp');
  await base.clone().gif().toFile(dir + '/tiny.gif');
  await base.clone().tiff().toFile(dir + '/tiny.tiff');
  await base.clone().avif().toFile(dir + '/tiny.avif');
  await base.clone().heif({ compression: 'hevc', quality: 80 }).toFile(dir + '/tiny.heic');

  // Pixel-Bomb: GÜLTIGES PNG mit 16001x16001 = 256_032_001 Pixeln
  await sharp({
    create: { width: 16001, height: 16001, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png({ compressionLevel: 9 })
    .toFile(dir + '/bomb.png');

  console.log('image fixtures generated');
})().catch((err) => { console.error(err); process.exit(1); });
" </dev/null

# Videos via ffmpeg
ffmpeg -y -f lavfi -i "testsrc=duration=1:size=16x16:rate=8" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p tiny.mp4
ffmpeg -y -f lavfi -i "testsrc=duration=1:size=16x16:rate=8" \
  -c:v libvpx-vp9 -b:v 10k tiny.webm

# slow: 30s 64x64 mit CPU-intensivem libvpx-vp9 (für Cancel-Tests)
ffmpeg -y -f lavfi -i "testsrc=duration=30:size=64x64:rate=30" \
  -c:v libvpx-vp9 -b:v 100k -cpu-used 0 slow.mp4

# Korruptes MP4
cp tiny.mp4 corrupt.mp4
dd if=/dev/zero of=corrupt.mp4 bs=1 count=32 conv=notrunc

ls -la *.jpg *.png *.webp *.gif *.tiff *.heic *.avif *.mp4 *.webm
