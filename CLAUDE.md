# Coding-Konventionen

Dieses Repo wird sowohl von Menschen als auch AI-Agenten gepflegt. Folgende Konventionen gelten verbindlich.

## Sprache

- Code: Englisch (Bezeichner, Kommentare, Commit-Messages)
- Dokumentation in `docs/` und Plan-Outputs: Deutsch (Projekt-Sprache)
- Test-Beschreibungen: Englisch

## Test-Disziplin

- TDD: Test ZUERST, dann Implementation. Pro Sicherheits-/Race-Annahme in der Spec einen Pflicht-Regressions-Test (siehe `docs/prompts/devils-advocate-regression-tests.md`).
- Tests liegen neben dem getesteten Code als `*.test.ts`.
- Kein eval, kein dynamic require, kein direkter `spawn('ffmpeg', ...)` außerhalb von `packages/compression/src/ffmpeg-args.ts` — die ESLint-Rule `no-direct-ffmpeg-spawn` blockt das.

## Commit-Messages

Conventional Commits, kurz, im Imperativ:

- `feat(scope): adds X`
- `fix(scope): handles Y`
- `chore(scope): updates Z`
- `docs: …`
- `ci: …`

## Sicherheits-Regeln (Spec Sektion 7)

- **Allowlists** für Codecs, MIMEs, Profile sind hardcoded in `packages/compression/src/types.ts`. Niemals dynamisch ableiten.
- **API-Keys** werden mit `HMAC-SHA-256(API_KEY_PEPPER, key)` gehashed (deterministisch, indexbar). Argon2id ist NUR für User-Passwörter.
- **Pfade**: User-Originaldateinamen kommen ausschließlich in `Job.inputFilename` (DB), niemals ins Filesystem.

## Iteration

Jeder Plan in `docs/superpowers/plans/` ist task-by-task abarbeitbar. Bevor ein Task als done markiert wird: lokale Tests grün, Lint clean, Typecheck grün, Commit. Frequent Commits sind wichtiger als große Features.
