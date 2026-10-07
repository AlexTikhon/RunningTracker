import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RejectedBufferNotice } from './RejectedBufferNotice.js';

const noop = () => undefined;

describe('RejectedBufferNotice', () => {
  it('announces the rejection and offers export before discard', () => {
    const markup = renderToStaticMarkup(
      <RejectedBufferNotice canDiscard={false} canExport message="The server refused the points." onDiscard={noop} onExport={noop} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Buffered points were rejected');
    expect(markup).toContain('The server refused the points.');
    expect(markup.indexOf('Export buffered points')).toBeLessThan(markup.indexOf('Discard buffered points and clear run'));
  });

  it('enables each action only when it is allowed', () => {
    const exportOnly = renderToStaticMarkup(
      <RejectedBufferNotice canDiscard={false} canExport message="m" onDiscard={noop} onExport={noop} />,
    );
    const both = renderToStaticMarkup(
      <RejectedBufferNotice canDiscard canExport message="m" onDiscard={noop} onExport={noop} />,
    );

    expect(exportOnly.match(/disabled=""/gu)).toHaveLength(1);
    expect(both).not.toContain('disabled=""');
  });
});
