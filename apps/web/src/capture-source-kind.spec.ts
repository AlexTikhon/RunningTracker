import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPTURE_SOURCE_KIND, parseCaptureSourceKind } from './capture-source-kind.js';

describe('parseCaptureSourceKind', () => {
  it('accepts exactly the two known sources', () => {
    expect(parseCaptureSourceKind('geolocation')).toBe('geolocation');
    expect(parseCaptureSourceKind('simulator')).toBe('simulator');
  });

  it('falls back to the default for anything a store could hold that is not a known source', () => {
    expect(DEFAULT_CAPTURE_SOURCE_KIND).toBe('geolocation');
    for (const value of [undefined, null, '', 'Simulator', 'gps', 7, {}, ['simulator']]) {
      expect(parseCaptureSourceKind(value)).toBe(DEFAULT_CAPTURE_SOURCE_KIND);
    }
  });
});
