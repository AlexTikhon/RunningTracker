import {
  GPX_ALREADY_IMPORTED,
  GPX_FILE_TOO_LARGE,
  GPX_IMPORT_MAX_BYTES,
  GPX_UNSUPPORTED,
  gpxAlreadyImportedDetailsSchema,
  type GpxImportPreview,
} from '@running-tracker/contracts';

import {
  FileImportController,
  idleFileImport,
  type FileConfirmer,
  type FileImportControllerOptions,
  type FileImportFormat,
  type FileImportPhase,
  type FileImportSnapshot,
  type FilePreviewer,
} from './file-import-controller.js';

// The GPX import of the Activity tab (ADR-0086). Its behaviour (identity, retries, unknown outcomes, duplicates,
// disposal) is the shared file import controller's; GPX supplies its limit, error codes and wording.

export type GpxPreviewer = FilePreviewer<GpxImportPreview>;
export type GpxConfirmer = FileConfirmer;
export type GpxImportPhase = FileImportPhase;
export type GpxImportSnapshot = FileImportSnapshot<GpxImportPreview>;
export type GpxImportControllerOptions = FileImportControllerOptions<GpxImportPreview>;

export const idleGpxImport: GpxImportSnapshot = idleFileImport;

export const gpxImportFormat: FileImportFormat = {
  alreadyImportedCode: GPX_ALREADY_IMPORTED,
  alreadyImportedDetailsSchema: gpxAlreadyImportedDetailsSchema,
  alreadyImportedMessage: 'This track is already one of your activities, so it was not imported again.',
  maxBytes: GPX_IMPORT_MAX_BYTES,
  savedMessage: 'GPX activity imported.',
  tooLargeCode: GPX_FILE_TOO_LARGE,
  unsupportedCode: GPX_UNSUPPORTED,
};

export class GpxImportController extends FileImportController<GpxImportPreview> {
  public constructor(options: GpxImportControllerOptions) {
    super(gpxImportFormat, options);
  }
}
