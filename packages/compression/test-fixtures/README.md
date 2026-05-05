# Compression-Engine Test-Fixtures

Reproduzierbar erzeugt durch `generate.sh`. Alle Fixtures sind synthetisch (keine PII, keine echten Fotos). `generate.sh` nutzt ausschließlich sharp + ffmpeg.

| Datei | Inhalt | Zweck |
|---|---|---|
| `tiny.{jpg,png,webp,gif,tiff,heic,avif}` | 256×256 Schachbrett | Format-Konvertierungs-Tests |
| `tiny.mp4`, `tiny.webm` | 1 s 16×16 testsrc | Video-Konvertierung-Tests (schnell) |
| `slow.mp4` | 30 s 64×64 testsrc, libvpx-vp9 cpu-used 0 | Cancel/Abort-Tests |
| `corrupt.mp4` | tiny.mp4 mit zerstörtem moov-Atom | ENGINE_INPUT_CORRUPT-Mapping |
| `bomb.png` | gültiges 16001×16001 PNG | Pixel-Bomb-Schutz |

**Voraussetzung:** sharp gegen system-libvips gebaut (Plan 2 Task 4-bis), `.npmrc` mit `SHARP_FORCE_GLOBAL_LIBVIPS=true`.
