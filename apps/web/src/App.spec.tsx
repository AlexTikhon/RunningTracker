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
  });
});
