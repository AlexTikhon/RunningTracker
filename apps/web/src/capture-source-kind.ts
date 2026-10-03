export type CaptureSourceKind = 'geolocation' | 'simulator';

export const DEFAULT_CAPTURE_SOURCE_KIND: CaptureSourceKind = 'geolocation';

// Validates a value read back from storage or a form. Anything unknown becomes the default, so a corrupt or
// older record can never put an unexpected source into the application.
export function parseCaptureSourceKind(value: unknown): CaptureSourceKind {
  return value === 'geolocation' || value === 'simulator' ? value : DEFAULT_CAPTURE_SOURCE_KIND;
}
