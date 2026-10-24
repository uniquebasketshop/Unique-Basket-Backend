/**
 * Expected (client-facing) error with an HTTP status and a stable errorCode.
 * The global error handler in app.ts turns it into the standard error response.
 */
export class AppError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.errorCode = errorCode;
  }
}
