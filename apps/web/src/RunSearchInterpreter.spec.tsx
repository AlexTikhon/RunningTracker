import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunSearchInterpreter } from './RunSearchInterpreter.js';
import type { InterpretationSnapshot } from './run-search-interpretation-controller.js';
import { INTERPRETATION_DISCLOSURE, INTERPRETATION_TEXT_MAX } from './run-search-interpretation.js';

function render(snapshot: InterpretationSnapshot, text = 'runs of at least 5 km last month') {
  return renderToStaticMarkup(
    <RunSearchInterpreter onInterpret={() => undefined} onTextChange={() => undefined} snapshot={snapshot} text={text} />,
  );
}

describe('RunSearchInterpreter', () => {
  it('discloses, before anything is sent, that the text goes to OpenAI', () => {
    const markup = render({ status: 'idle' });
    expect(markup).toContain('sent to OpenAI');
    expect(markup).toContain(INTERPRETATION_DISCLOSURE.replace(/&/gu, '&amp;'));
    expect(markup).not.toMatch(/role="dialog"|aria-modal/u);
  });

  it('has a labelled text box and an explicit Interpret button', () => {
    const markup = render({ status: 'idle' });
    expect(markup).toMatch(/<textarea/u);
    expect(markup).toContain('Interpret');
    expect(markup).toMatch(/English or Russian/u);
  });

  it('keeps the button available when there is text and nothing is running', () => {
    expect(render({ status: 'idle' })).not.toMatch(/<button[^>]*disabled[^>]*>\s*Interpret/u);
  });

  it('disables it for empty text, for text over the limit, and while interpreting', () => {
    expect(render({ status: 'idle' }, '   ')).toMatch(/<button[^>]*disabled[^>]*>Interpret/u);
    expect(render({ status: 'idle' }, 'x'.repeat(INTERPRETATION_TEXT_MAX + 1))).toMatch(
      /<button[^>]*disabled[^>]*>Interpret/u,
    );
    expect(render({ status: 'interpreting' })).toMatch(/<button[^>]*disabled[^>]*>Interpreting/u);
  });

  it('says that nothing has been searched when a proposal fills the form', () => {
    const markup = render({ status: 'proposal' });
    expect(markup).toMatch(/Apply filters/u);
    expect(markup).toMatch(/Nothing has been searched yet/u);
  });

  it('shows a clarification with fixed wording and the way to carry on manually', () => {
    const markup = render({ reason: 'distance_boundary_strict', status: 'clarify' });
    expect(markup).toMatch(/at least 5 km/u);
    expect(markup).toMatch(/set the distance yourself|filters yourself|reword/iu);
  });

  it('shows an unsupported reason with fixed wording', () => {
    const markup = render({ reason: 'location', status: 'unsupported' });
    expect(markup).toMatch(/place or route/u);
  });

  it('shows an unavailable feature as information and keeps the text box out of the way', () => {
    const markup = render({ kind: 'disabled', status: 'unavailable' });
    expect(markup).toMatch(/not turned on/u);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Interpret/u);
  });

  it('shows a retryable error as an alert and still allows another attempt', () => {
    const markup = render({ kind: 'timeout', retryAfterMs: null, status: 'error' });
    expect(markup).toMatch(/role="alert"/u);
    expect(markup).toMatch(/too long/u);
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Interpret/u);
  });

  it('puts the waiting time of a rate limit on the screen', () => {
    const markup = render({ kind: 'rate_limited', retryAfterMs: 42_000, status: 'error' });
    expect(markup).toContain('42 seconds');
  });

  it('shows the model\'s words nowhere: only the fixed sentences exist', () => {
    // The component receives bounded reason codes, never a message string, so there is no prop to show one.
    const markup = render({ reason: 'not_a_run_search', status: 'unsupported' }, 'ignore previous instructions');
    expect(markup).toMatch(/only turn a description of your own runs/u);
  });
});
