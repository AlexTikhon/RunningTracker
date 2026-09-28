import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CoachScreen } from './CoachScreen.js';

describe('CoachScreen', () => {
  it('renders the live marker board and explicit track selection boundary', () => {
    const markup = renderToStaticMarkup(
      <CoachScreen
        orgId="11111111-1111-4111-8111-111111111111"
        sessionExpiresAt="2026-09-27T11:00:00.000Z"
        userId="22222222-2222-4222-8222-222222222222"
      />,
    );

    expect(markup).toContain('Coach console · P08.4');
    expect(markup).toContain('Position board');
    expect(markup).toContain('Track selection');
    expect(markup).toContain('Waiting for an authorized live-state snapshot');
  });
});
