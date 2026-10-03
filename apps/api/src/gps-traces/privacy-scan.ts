// A defence-in-depth check on the text of a sanitized fixture. The strict schema already rejects unknown fields; this
// scan also catches private data that fits the schema's shapes: a coordinate pasted into a metric field, a Unix time
// in `elapsedMs`, a date in a string. It is heuristic and cannot prove that a fixture is safe. Findings describe the
// kind of problem and never repeat the offending value, so they can be pasted into an issue.

const FORBIDDEN_KEY =
  /"(?:lat\w*|lon\w*|lng\w*|time\w*|date\w*|recorded\w*|device\w*|serial\w*|creator|author|name|email|file\w*|origin\w*|anchor\w*|owner\w*|user\w*|imei|uuid|id)"\s*:/iu;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/u;
const TIME_OF_DAY = /\d{1,2}:\d{2}:\d{2}/u;
const NUMBER = /-?\d+(?:\.\d+)?/gu;

export function findPrivacyViolations(text: string): string[] {
  const findings: string[] = [];
  if (FORBIDDEN_KEY.test(text)) {
    findings.push('a field name that identifies a location, a time, a device or a person');
  }
  if (ISO_DATE.test(text)) {
    findings.push('a calendar date');
  }
  if (TIME_OF_DAY.test(text)) {
    findings.push('a time of day');
  }
  for (const match of text.matchAll(NUMBER)) {
    const [whole = '', fraction = ''] = match[0].replace('-', '').split('.');
    if (whole.length >= 9) {
      findings.push('a number with 9 or more integer digits (it looks like a Unix time)');
      break;
    }
    if (fraction.length >= 4) {
      findings.push('a number with 4 or more decimals (it looks like a geographic coordinate)');
      break;
    }
  }
  return findings;
}
