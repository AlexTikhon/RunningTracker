import {
  TCX_ALREADY_IMPORTED,
  TCX_FILE_TOO_LARGE,
  TCX_IMPORT_MAX_BYTES,
  TCX_UNSUPPORTED,
  tcxAlreadyImportedDetailsSchema,
  type TcxImportPreview,
} from '@running-tracker/contracts';

import {
  FileImportController,
  idleFileImport,
  type FileImportControllerOptions,
  type FileImportFormat,
  type FileImportSnapshot,
} from './file-import-controller.js';

// The TCX import of the Activity tab (ADR-0091): the shared file import controller with TCX's limit, error codes and
// wording. A TCX duplicate is only ever another TCX import (the server never compares formats).

export type TcxImportSnapshot = FileImportSnapshot<TcxImportPreview>;
export type TcxImportControllerOptions = FileImportControllerOptions<TcxImportPreview>;

export const idleTcxImport: TcxImportSnapshot = idleFileImport;

export const tcxImportFormat: FileImportFormat = {
  alreadyImportedCode: TCX_ALREADY_IMPORTED,
  alreadyImportedDetailsSchema: tcxAlreadyImportedDetailsSchema,
  alreadyImportedMessage: 'This TCX activity is already one of your imports, so it was not imported again.',
  maxBytes: TCX_IMPORT_MAX_BYTES,
  savedMessage: 'TCX activity imported.',
  tooLargeCode: TCX_FILE_TOO_LARGE,
  unsupportedCode: TCX_UNSUPPORTED,
};

export class TcxImportController extends FileImportController<TcxImportPreview> {
  public constructor(options: TcxImportControllerOptions) {
    super(tcxImportFormat, options);
  }
}
