import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArchiveRunDelete } from './ArchiveRunDelete.js';
import type { RunDeletionSnapshot } from './run-deletion.js';

const noop = () => undefined;
const render = (snapshot: RunDeletionSnapshot) =>
  renderToStaticMarkup(
    <ArchiveRunDelete
      id="confirm-1"
      onCancel={noop}
      onConfirm={noop}
      snapshot={snapshot}
      startedAtLabel="21 Oct 2026, 08:00"
    />,
  );
const buttons = (markup: string) =>
  [...markup.matchAll(/<button([^>]*)>([^<]*)<\/button>/gu)].map((match) => ({
    disabled: (match[1] ?? '').includes('disabled'),
    text: match[2],
  }));

describe('ArchiveRunDelete', () => {
  it('asks about the run by the date its card shows, says the deletion is permanent, and offers Cancel and Confirm delete', () => {
    const markup = render({ message: null, phase: 'confirming' });
    expect(markup).toContain('id="confirm-1"');
    const titleId = /aria-labelledby="([^"]+)"/u.exec(markup)?.[1];
    expect(markup).toContain(`<h5 id="${titleId}" tabindex="-1">Delete your run of 21 Oct 2026, 08:00?</h5>`);
    expect(markup).toMatch(/permanently deletes the run/u);
    expect(markup).toMatch(/cannot be undone/u);
    expect(buttons(markup)).toEqual([
      { disabled: false, text: 'Cancel' },
      { disabled: false, text: 'Confirm delete' },
    ]);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('Deleting');
  });

  it('can press nothing while the request is on its way, and says so', () => {
    const markup = render({ message: null, phase: 'pending' });
    expect(markup).toContain('<p role="status">Deleting…</p>');
    expect(buttons(markup)).toEqual([
      { disabled: true, text: 'Cancel' },
      { disabled: true, text: 'Deleting…' },
    ]);
  });

  it('shows a failure as an alert, never as deleted, and offers the same deletion again', () => {
    const message = 'The deletion was not confirmed: The connection failed. The run may already be deleted. Trying again is safe.';
    const markup = render({ message, phase: 'failed' });
    expect(markup).toContain(`role="alert">${message}</p>`);
    expect(markup).not.toMatch(/was deleted\./u);
    expect(buttons(markup)).toEqual([
      { disabled: false, text: 'Cancel' },
      { disabled: false, text: 'Retry delete' },
    ]);
  });

  it('leaves only Close for a run that cannot be deleted', () => {
    const markup = render({ message: 'This run is not available to you, so it cannot be deleted.', phase: 'unavailable' });
    expect(markup).toContain('role="alert">This run is not available to you');
    expect(buttons(markup)).toEqual([{ disabled: false, text: 'Close' }]);
  });

  it('keeps everything disabled in the moment between the confirmation and closing', () => {
    expect(buttons(render({ message: null, phase: 'deleted' })).every((entry) => entry.disabled)).toBe(true);
  });
});
