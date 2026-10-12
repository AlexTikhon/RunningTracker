import { describe, expect, it } from 'vitest';

import {
  buildInterpretationMessages,
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
} from './interpretation-prompt.js';

const input = { text: 'Show my runs of at least 5 km from last month, longest first.', timeZone: 'Europe/Warsaw', today: '2026-10-15' };

describe('interpretation prompt', () => {
  it('has a version that changes with the instructions', () => {
    expect(INTERPRETATION_PROMPT_VERSION).toMatch(/^run-search-interpreter\/\d{4}-\d{2}-\d{2}\.\d+$/u);
  });

  it('keeps the person\'s text out of the instructions, which are fixed', () => {
    const messages = buildInterpretationMessages({ ...input, text: 'SENTINEL-TEXT-9f3a' });
    expect(INTERPRETATION_INSTRUCTIONS).not.toContain('SENTINEL-TEXT-9f3a');
    expect(INTERPRETATION_INSTRUCTIONS).not.toContain('Europe/Warsaw');
    expect(INTERPRETATION_INSTRUCTIONS).not.toContain('2026-10-15');
    expect(JSON.stringify(messages)).toContain('SENTINEL-TEXT-9f3a');
  });

  it('sends the text unchanged as the only user message, after the calendar context', () => {
    const text = '  Мои пробежки\nот 5 км за прошлый месяц  ';
    const messages = buildInterpretationMessages({ ...input, text });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'developer' });
    expect(messages[1]).toEqual({ content: text, role: 'user' });
  });

  it('carries only the zone and the local date as calendar context', () => {
    const [context] = buildInterpretationMessages(input);
    expect(context!.content).toContain('Europe/Warsaw');
    expect(context!.content).toContain('2026-10-15');
    expect(context!.content).not.toContain(input.text);
    expect(context!.content.length).toBeLessThan(400);
  });

  it('states the rules that keep the meaning exact', () => {
    for (const rule of [
      'inclusive',
      'more than',
      'never round',
      'ignore',
      'unsupported',
      'clarify',
      'last month',
      'null',
    ]) {
      expect(INTERPRETATION_INSTRUCTIONS.toLowerCase(), rule).toContain(rule);
    }
  });

  it('gives pace and speed to one reason only, so an expected answer is unique', () => {
    const sortSection = /SORT\n([\s\S]*?)\n\nUNSUPPORTED/u.exec(INTERPRETATION_INSTRUCTIONS)?.[1] ?? '';
    expect(sortSection).not.toMatch(/fastest|pace|speed/iu);
    expect(INTERPRETATION_INSTRUCTIONS).toMatch(/pace_or_speed: .*(sort|order|fastest)/u);
  });

  it('is of a size that is cheap to send on every request', () => {
    expect(INTERPRETATION_INSTRUCTIONS.length).toBeLessThan(6_000);
  });
});
