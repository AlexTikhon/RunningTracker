import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  it('renders the idle runner controls and independent status channels', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Runner console · P05.5');
    expect(markup).toContain('Start run');
    expect(markup).toContain('Recording');
    expect(markup).toContain('Network');
    expect(markup).toContain('Upload');
    expect(markup).toContain('Server state');
    expect(markup).toContain('Writer');
    expect(markup).toContain('Capture source');
    expect(markup).toContain('Device GPS');
    expect(markup).toContain('Simulator · normal · seed 1');
    expect(markup).toContain('Runner');
    expect(markup).toContain('Coach');
    expect(markup).toContain('Archive');
  });

  it('never asks for an organization identifier', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).not.toContain('Organization ID');
    expect(markup).not.toContain('00000000-0000-4000-8000-000000000000');
    expect(markup).not.toContain('<input');
  });

  it('starts by checking the session, with no sign-out offered before there is one', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Checking session');
    expect(markup).not.toContain('Sign out');
  });
});

describe('App simulator choice', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The choice is made when the module loads, from the same guard as the demo sign-in buttons, so each case loads a
  // fresh copy of App under its own environment.
  async function markupWith(env: { DEV: boolean; VITE_LOCAL_DEMO_ENABLED?: string }): Promise<string> {
    vi.stubEnv('DEV', env.DEV);
    if (env.VITE_LOCAL_DEMO_ENABLED !== undefined) vi.stubEnv('VITE_LOCAL_DEMO_ENABLED', env.VITE_LOCAL_DEMO_ENABLED);
    vi.resetModules();
    const { App: FreshApp } = await import('./App.js');
    return renderToStaticMarkup(<FreshApp />);
  }

  it('offers the two-minute demo simulator on a dev server with the local demo flag', async () => {
    const markup = await markupWith({ DEV: true, VITE_LOCAL_DEMO_ENABLED: 'true' });

    expect(markup).toContain('<option value="simulator">Simulator · local demo · about 2 min</option>');
    expect(markup).not.toContain('Simulator · normal · seed 1');
  });

  it.each([
    { DEV: true },
    { DEV: true, VITE_LOCAL_DEMO_ENABLED: 'false' },
    { DEV: true, VITE_LOCAL_DEMO_ENABLED: 'TRUE' },
    { DEV: false, VITE_LOCAL_DEMO_ENABLED: 'true' },
  ])('keeps the six-point seeded simulator otherwise (%o)', async (env) => {
    const markup = await markupWith(env);

    expect(markup).toContain('<option value="simulator">Simulator · normal · seed 1</option>');
    expect(markup).not.toContain('local demo');
  });
});
