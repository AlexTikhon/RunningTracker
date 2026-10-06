import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
