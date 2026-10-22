import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CoachMap } from './CoachMap.js';
import { emptyCoachMapGeometry, type CoachMapGeometry } from './coach-map-geometry.js';
import { CoachScreen } from './CoachScreen.js';

function screen(mapboxAccessToken: string | null): string {
  return renderToStaticMarkup(
    <CoachScreen
      mapboxAccessToken={mapboxAccessToken}
      orgId="11111111-1111-4111-8111-111111111111"
      sessionExpiresAt="2026-09-27T11:00:00.000Z"
      signal={new AbortController().signal}
      userId="22222222-2222-4222-8222-222222222222"
    />,
  );
}

describe('CoachScreen', () => {
  it('renders the live marker board and explicit track selection boundary', () => {
    const markup = screen(null);

    expect(markup).toContain('Coach console · P08.4');
    expect(markup).toContain('Position board');
    expect(markup).toContain('Track selection');
    expect(markup).toContain('Waiting for an authorized live-state snapshot');
  });

  it('keeps the board and the picker without a token and says only that the map is unavailable', () => {
    const markup = screen(null);

    expect(markup).toContain('Map unavailable. Positions and tracks are listed below.');
    expect(markup).not.toContain('VITE_MAPBOX_ACCESS_TOKEN');
    expect(markup).not.toContain('Fit visible runs');
    expect(markup).not.toContain('Map legend');
  });

  it('renders the map frame, legend and a disabled fit control before the map is usable', () => {
    const markup = screen('pk.test');

    expect(markup).toContain('Loading map…');
    expect(markup).toContain('aria-label="Map legend"');
    expect(markup).toContain('Unconfirmed position: ring');
    expect(markup).toMatch(/<button disabled="" type="button">Fit visible runs<\/button>/u);
    expect(markup).toContain('No positions on the map.');
  });
});

describe('CoachMap', () => {
  const runId = '11111111-1111-4111-8111-111111111111';

  it('describes the drawn positions by quality and never calls retained geometry the latest', () => {
    const geometry: CoachMapGeometry = {
      ...emptyCoachMapGeometry(),
      bounds: [[21, 52], [21.1, 52]],
      markerCounts: { confirmed: 1, stale: 1, unconfirmed: 0 },
      trackStatuses: [
        { drawnRevision: '3', label: 'Run #11111111', latest: false, runId, status: 'loading', targetRevision: '5' },
        { drawnRevision: '3', label: 'Run #22222222', latest: false, runId: `${runId}2`, status: 'error', targetRevision: '5' },
        { drawnRevision: '7', label: 'Run #33333333', latest: true, runId: `${runId}3`, status: 'ready', targetRevision: '7' },
        { drawnRevision: null, label: 'Run #44444444', latest: false, runId: `${runId}4`, status: 'loading', targetRevision: '2' },
      ],
    };
    const markup = renderToStaticMarkup(
      <CoachMap accessToken="pk.test" geometry={geometry} signal={new AbortController().signal} />,
    );

    expect(markup).toContain('2 positions on the map: 1 confirmed, 1 stale.');
    expect(markup).toContain('Run #11111111: showing older rev 3 while rev 5 loads');
    expect(markup).toContain('Run #22222222: showing older rev 3; rev 5 could not be loaded');
    expect(markup).toContain('Run #33333333: rev 7, latest');
    expect(markup).toContain('Run #44444444: loading rev 2');
  });
});
