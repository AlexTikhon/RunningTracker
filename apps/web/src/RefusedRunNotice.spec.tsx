import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RefusedRunNotice } from './RefusedRunNotice.js';

const noop = () => undefined;
const base = {
  canCheckAgain: true,
  canDiscard: true,
  canExport: true,
  confirming: false,
  detachable: true,
  message: 'The run has been deleted (RUN_DELETED).',
  pendingCount: 3,
  onCancelDiscard: noop,
  onCheckAgain: noop,
  onConfirmDiscard: noop,
  onExport: noop,
  onRequestDiscard: noop,
};

const disabledCount = (markup: string) => markup.match(/disabled=""/gu)?.length ?? 0;

describe('RefusedRunNotice', () => {
  it('says what the server answered, that recording is stopped and that the points are still on the device', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The run has been deleted (RUN_DELETED).');
    expect(markup).toContain('Recording stays stopped');
    expect(markup).toContain('3 unsent points');
  });

  it('offers check again, export and the local discard, with the export before the discard', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} />);
    expect(markup).toContain('Check again');
    expect(markup).toContain('Export buffered points');
    expect(markup).toContain('Discard local recovery');
    expect(markup.indexOf('Export buffered points')).toBeLessThan(markup.indexOf('Discard local recovery'));
    expect(disabledCount(markup)).toBe(0);
  });

  it('asks before it discards: the first press opens the confirmation and the confirm button is not there yet', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} />);
    expect(markup).not.toContain('Discard local recovery and start over');
    expect(markup).not.toContain('Keep local recovery');
  });

  it('the confirmation says what is and is not affected', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} confirming />);
    expect(markup).toContain('Discard local recovery and start over');
    expect(markup).toContain('Keep local recovery');
    expect(markup).toContain('only clears this browser');
    expect(markup).toContain('does not restore the run or delete anything on the server');
    expect(markup).toContain('no longer be recoverable');
    expect(markup).toContain('Export the points first');
    expect(markup).toContain('3 unsent points');
  });

  it('a refusal that says nothing about the run offers no discard at all', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} detachable={false} confirming />);
    expect(markup).toContain('Check again');
    expect(markup).toContain('Export buffered points');
    expect(markup).not.toContain('Discard local recovery');
    expect(markup).not.toContain('start over');
  });

  it('a tab that does not own the writer lease can look and export but not discard', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} canDiscard={false} />);
    expect(markup).toContain('Discard local recovery');
    expect(disabledCount(markup)).toBe(1);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Discard local recovery/u);
    const confirming = renderToStaticMarkup(<RefusedRunNotice {...base} canDiscard={false} confirming />);
    expect(confirming).toMatch(/<button[^>]*disabled=""[^>]*>Discard local recovery and start over/u);
  });

  it('check again and export follow their own conditions', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} canCheckAgain={false} canExport={false} />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Check again/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Export buffered points/u);
  });

  it('says so when there is nothing unsent to lose', () => {
    const markup = renderToStaticMarkup(<RefusedRunNotice {...base} confirming pendingCount={0} />);
    expect(markup).toContain('no unsent points');
  });
});
