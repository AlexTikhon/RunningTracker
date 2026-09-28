import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArchiveScreen } from './ArchiveScreen.js';

describe('ArchiveScreen', () => {
  it('renders the bounded archive period and tokenless source state', () => {
    const markup = renderToStaticMarkup(
      <ArchiveScreen
        accessToken={null}
        orgId="11111111-1111-4111-8111-111111111111"
        userId="22222222-2222-4222-8222-222222222222"
      />,
    );

    expect(markup).toContain('Archive map · P09.5');
    expect(markup).toContain('Apply period');
    expect(markup).toContain('Refresh now');
    expect(markup).toContain('Map provider not configured');
    expect(markup).toContain('Metadata refreshes every 30 seconds');
  });
});
