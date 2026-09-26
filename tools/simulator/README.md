# GPS simulator CLI

The P04.4 CLI replays deterministic scenarios from `@running-tracker/fixtures` as JSON Lines. It never waits on wall time and performs no network or database I/O.

```powershell
npm run simulate:gps -- --scenario reordered --seed 42 --start 2026-01-01T08:00:00.000Z
npm run simulate:gps -- --list
```

The first line is scenario metadata; subsequent lines are virtual-time capture and upload-attempt events. `dropped-response` emits a `drop-after-commit` directive for a future harness but does not enable API fault injection.
