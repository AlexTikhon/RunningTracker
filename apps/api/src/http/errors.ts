export class HttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${statusCode}`);
    this.name = 'HttpError';
  }
}
