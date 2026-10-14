import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildInterpretationMessages,
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
  OLLAMA_INTERPRETATION_INSTRUCTIONS,
  OLLAMA_INTERPRETATION_PROMPT_VERSION,
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

describe('Ollama instructions', () => {
  const outcomeBlock = (text: string): string => /\nOUTCOMES\n([\s\S]*?)\nNever drop/u.exec(text)?.[1] ?? '';
  const withoutOutcomeBlock = (text: string): string => text.replace(outcomeBlock(text), '');

  it('leaves the OpenAI instructions byte for byte as they were', () => {
    // SHA-256 of the instructions before the Ollama variant existed (commit 1a2aac0).
    expect(createHash('sha256').update(INTERPRETATION_INSTRUCTIONS).digest('hex')).toBe(
      '063b78201e62628abb944675de44faf67cccde32c315a776cafee502bf8ddfd4',
    );
    expect(INTERPRETATION_PROMPT_VERSION).toBe('run-search-interpreter/2026-10-12.2');
  });

  it('differs from the OpenAI instructions in the output-format lines of OUTCOMES and nowhere else', () => {
    expect(OLLAMA_INTERPRETATION_INSTRUCTIONS).not.toBe(INTERPRETATION_INSTRUCTIONS);
    expect(outcomeBlock(OLLAMA_INTERPRETATION_INSTRUCTIONS)).not.toBe(outcomeBlock(INTERPRETATION_INSTRUCTIONS));
    expect(withoutOutcomeBlock(OLLAMA_INTERPRETATION_INSTRUCTIONS)).toBe(
      withoutOutcomeBlock(INTERPRETATION_INSTRUCTIONS),
    );
  });

  it('keeps the reason precedence and the interpretation rules, and states the per-outcome shapes', () => {
    expect(OLLAMA_INTERPRETATION_INSTRUCTIONS).toContain(
      'an unsupported reason wins over a clarification, and a clarification uses the first applicable reason in this order: conflicting_conditions, period_missing, period_ambiguous, distance_unit_mixed, distance_unit_missing, distance_boundary_strict, distance_too_precise, distance_ambiguous.',
    );
    const block = outcomeBlock(OLLAMA_INTERPRETATION_INSTRUCTIONS);
    expect(block).toContain('exactly two keys: outcome and clarificationReason');
    expect(block).toContain('exactly two keys: outcome and unsupportedReason');
    expect(block).toContain('outcome, period');
    // The OpenAI wording asks for nulls in a flat object; this wire shape has no such fields to fill.
    expect(block).not.toContain('Set clarificationReason and');
  });

  it('keeps the person\'s text out of the instructions and has its own version', () => {
    expect(OLLAMA_INTERPRETATION_INSTRUCTIONS).not.toContain('Europe/Warsaw');
    expect(OLLAMA_INTERPRETATION_INSTRUCTIONS).not.toContain('2026-10-15');
    expect(OLLAMA_INTERPRETATION_PROMPT_VERSION).toMatch(/^run-search-interpreter-ollama\/\d{4}-\d{2}-\d{2}\.\d+$/u);
    expect(OLLAMA_INTERPRETATION_PROMPT_VERSION).not.toBe(INTERPRETATION_PROMPT_VERSION);
  });
});
