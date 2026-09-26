import {
  GPS_SCENARIO_NAMES,
  createGpsScenario,
  isGpsScenarioName,
  replayGpsScenario,
  type GpsScenarioName,
} from '@running-tracker/fixtures';

interface CliOptions {
  readonly list: boolean;
  readonly name: GpsScenarioName;
  readonly seed: number;
  readonly startAt?: string;
}

const HELP = `Usage: npm run simulate:gps -- [options]

Options:
  --scenario <name>  Scenario name (default: normal)
  --seed <uint32>    Deterministic seed (default: 1)
  --start <time>     UTC start instant (default: 2026-01-01T08:00:00.000Z)
  --list             Print available scenario names
  --help             Print this help
`;

function requireValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCliArguments(arguments_: readonly string[]): CliOptions | 'help' {
  let name: GpsScenarioName = 'normal';
  let seed = 1;
  let startAt: string | undefined;
  let list = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case '--help':
        return 'help';
      case '--list':
        list = true;
        break;
      case '--scenario': {
        const value = requireValue(arguments_, index, '--scenario');
        if (!isGpsScenarioName(value)) {
          throw new Error(`unknown scenario: ${value}`);
        }
        name = value;
        index += 1;
        break;
      }
      case '--seed': {
        const value = requireValue(arguments_, index, '--seed');
        if (!/^\d+$/u.test(value)) throw new Error('--seed must be an unsigned integer');
        seed = Number(value);
        index += 1;
        break;
      }
      case '--start':
        startAt = requireValue(arguments_, index, '--start');
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument ?? ''}`);
    }
  }

  return startAt === undefined ? { list, name, seed } : { list, name, seed, startAt };
}

export function runCli(arguments_: readonly string[], write: (text: string) => void): void {
  const options = parseCliArguments(arguments_);
  if (options === 'help') {
    write(HELP);
    return;
  }
  if (options.list) {
    write(`${GPS_SCENARIO_NAMES.join('\n')}\n`);
    return;
  }

  const scenario = createGpsScenario({
    name: options.name,
    seed: options.seed,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  });
  write(
    `${JSON.stringify({
      captureCount: scenario.captures.length,
      name: scenario.name,
      seed: scenario.seed,
      startAt: scenario.startAt,
      type: 'scenario',
      uploadAttemptCount: scenario.uploads.length,
    })}\n`,
  );
  for (const event of replayGpsScenario(scenario)) {
    write(`${JSON.stringify(event)}\n`);
  }
}
