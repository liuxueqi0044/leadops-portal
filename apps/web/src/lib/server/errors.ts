import { ServiceError } from '@leadops/db';
import { AuthorizationError } from '@leadops/core';

export function handleServiceError(err: unknown): Response {
  if (err instanceof ServiceError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.httpStatus },
    );
  }
  if (err instanceof AuthorizationError) {
    return Response.json(
      { error: { code: 'FORBIDDEN', message: err.message } },
      { status: 403 },
    );
  }
  if (err instanceof Error) {
    return Response.json(
      { error: { code: 'INTERNAL', message: 'Internal server error' } },
      { status: 500 },
    );
  }
  throw err;
}
