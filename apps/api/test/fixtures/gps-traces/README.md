# Sanitized GPS trace fixtures (D10)

Only sanitized `*.trace.json` fixtures belong in this directory. Nothing else may be committed here: a test fails on any other file, such as a raw GPX export.

A fixture holds relative time and local metric offsets from the first fix. It does not hold the original coordinates, the date or time of day, a device identifier or the original file name. See `docs/runbooks/gps-traces.md` for the privacy model, its limits and the workflow.

Create one with:

```powershell
npm run gps:sanitize -- .local/gps-traces/raw/<export>.gpx --scenario steady_run --output apps/api/test/fixtures/gps-traces/steady_run_01.trace.json
```

Review the file, then regenerate the report with `npm run gps:report` and commit the fixture together with `docs/reports/d10-real-traces.md`.
