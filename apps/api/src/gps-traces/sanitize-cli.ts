import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, sep } from 'node:path';

import { parseGpx } from './gpx.js';
import { findPrivacyViolations } from './privacy-scan.js';
import { RAW_TRACE_DIR, resolveUserPath } from './paths.js';
import { ASSUMED_ACCURACY_M } from './replay.js';
import { RawTraceError } from './raw-trace.js';
import { sanitizeRawTrace } from './sanitize.js';
import { sourceCharacteristics } from './statistics.js';
import {
  SCENARIOS,
  parseSanitizedTraceText,
  serializeSanitizedTrace,
  type Scenario,
} from './trace-schema.js';

const MAX_RAW_FILE_BYTES = 200 * 1024 * 1024;
const FIXTURE_FILE_NAME = /^[a-z0-9][a-z0-9_-]*\.trace\.json$/u;

export const SANITIZE_USAGE =
  'Usage: npm run gps:sanitize -- <raw.gpx> --scenario <' +
  SCENARIOS.join('|') +
  '> --output <name.trace.json> [--reference-distance-m <metres>] [--force]';

export interface SanitizeCliDependencies {
  readonly argv: readonly string[];
  /** The directory relative paths are resolved against. */
  readonly cwd: string;
  readonly log: (line: string) => void;
  /** Overridable for tests; the private directory a fixture must never be written into. */
  readonly rawDir?: string;
}

interface SanitizeArguments {
  readonly force: boolean;
  readonly output: string;
  readonly rawFile: string;
  readonly referenceDistanceM: number | undefined;
  readonly scenario: Scenario;
}

function parseArguments(argv: readonly string[]): SanitizeArguments {
  let rawFile: string | undefined;
  let scenario: string | undefined;
  let output: string | undefined;
  let referenceDistanceM: number | undefined;
  let force = false;

  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position] as string;
    if (argument === '--force') {
      force = true;
    } else if (argument === '--scenario' || argument === '--output' || argument === '--reference-distance-m') {
      const value = argv[position + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value. ${SANITIZE_USAGE}`);
      }
      position += 1;
      if (argument === '--scenario') {
        scenario = value;
      } else if (argument === '--output') {
        output = value;
      } else if (/^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0) {
        referenceDistanceM = Number(value);
      } else {
        throw new Error(`--reference-distance-m must be a positive number of metres. ${SANITIZE_USAGE}`);
      }
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown argument ${argument}. ${SANITIZE_USAGE}`);
    } else if (rawFile === undefined) {
      rawFile = argument;
    } else {
      throw new Error(`Unknown argument ${argument}. ${SANITIZE_USAGE}`);
    }
  }

  if (rawFile === undefined) {
    throw new Error(`A raw file is required. ${SANITIZE_USAGE}`);
  }
  if (scenario === undefined) {
    throw new Error(`--scenario is required. ${SANITIZE_USAGE}`);
  }
  if (!(SCENARIOS as readonly string[]).includes(scenario)) {
    throw new Error(`Unknown scenario. Use one of: ${SCENARIOS.join(', ')}`);
  }
  if (output === undefined) {
    throw new Error(`--output is required. ${SANITIZE_USAGE}`);
  }
  return { force, output, rawFile, referenceDistanceM, scenario: scenario as Scenario };
}

function assertReadableFormat(rawPath: string): void {
  const extension = extname(rawPath).toLowerCase();
  if (extension === '.gpx') {
    return;
  }
  if (extension === '.fit') {
    throw new RawTraceError('FIT is a binary format this tool does not read; export the FIT file to GPX first');
  }
  throw new RawTraceError(
    'Only GPX files are read (a .gpx extension is required). Convert TCX, KML, GeoJSON or CSV to GPX first',
  );
}

export function runSanitizeCli(dependencies: SanitizeCliDependencies): void {
  const { cwd, log } = dependencies;
  const rawDir = dependencies.rawDir ?? RAW_TRACE_DIR;
  const args = parseArguments(dependencies.argv);

  const outputPath = resolveUserPath(args.output, cwd);
  if (!FIXTURE_FILE_NAME.test(basename(outputPath))) {
    throw new Error(
      'The fixture file name must be lowercase letters, digits, "_" or "-" and end in .trace.json, for example steady_run_01.trace.json; do not put a person or a place in it',
    );
  }
  if (outputPath.startsWith(rawDir + sep)) {
    throw new Error('A sanitized fixture must not be written into the private raw directory');
  }
  if (existsSync(outputPath) && !args.force) {
    throw new Error('The output fixture already exists; choose another name or pass --force to replace it');
  }

  const rawPath = resolveUserPath(args.rawFile, cwd);
  assertReadableFormat(rawPath);
  let text: string;
  try {
    if (statSync(rawPath).size > MAX_RAW_FILE_BYTES) {
      throw new RawTraceError('The raw file is larger than 200 MiB; trim it before sanitizing');
    }
    text = readFileSync(rawPath, 'utf8');
  } catch (error) {
    if (error instanceof RawTraceError) {
      throw error;
    }
    // The path is not repeated: it may contain a name.
    throw new Error('Cannot read the raw file; check that the path exists', { cause: error });
  }

  const trace = sanitizeRawTrace(parseGpx(text), {
    scenario: args.scenario,
    ...(args.referenceDistanceM === undefined ? {} : { referenceDistanceM: args.referenceDistanceM }),
  });
  const serialized = serializeSanitizedTrace(trace);
  // What is written is read back through the same validation a reviewer's tooling will use.
  parseSanitizedTraceText(serialized);
  const findings = findPrivacyViolations(serialized);
  if (findings.length > 0) {
    throw new Error(`The sanitized output was not written because it looks like it contains private data: ${findings.join('; ')}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { flag: args.force ? 'w' : 'wx' });

  const summary = sourceCharacteristics(trace);
  log(`Sanitized fixture written: ${relative(cwd, outputPath).split(sep).join('/')}`);
  log(`scenario: ${trace.scenario}`);
  log(`points: ${String(summary.pointCount)}`);
  log(`duration: ${summary.durationS.toFixed(1)} s`);
  log(`approximate distance (polyline in the sanitized frame): ${summary.planarDistanceM.toFixed(1)} m`);
  if (summary.intervalS !== null) {
    log(
      `sampling interval: median ${summary.intervalS.median.toFixed(2)} s, p95 ${summary.intervalS.p95.toFixed(2)} s, max ${summary.intervalS.max.toFixed(2)} s; gaps over 10 s: ${String(summary.gapCount)}`,
    );
  }
  if (summary.accuracyM === null) {
    log(`accuracy: not reported; replay assumes ${String(ASSUMED_ACCURACY_M)} m`);
  } else {
    log(`accuracy: reported (median ${summary.accuracyM.median.toFixed(1)} m, max ${summary.accuracyM.max.toFixed(1)} m)`);
  }
  log('Review the file before committing it. The raw file stays in the private directory and is never committed.');
}
