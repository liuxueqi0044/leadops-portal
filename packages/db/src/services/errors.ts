export type ServiceErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID'
  | 'EXPIRED'
  | 'UNAUTHENTICATED';

/** Stable error codes mapped to stable HTTP statuses by the API layer. */
export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'FORBIDDEN':
        return 403;
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
        return 409;
      case 'EXPIRED':
      case 'INVALID':
        return 400;
      case 'UNAUTHENTICATED':
        return 401;
    }
  }
}

export function notFound(message = 'resource not found'): ServiceError {
  return new ServiceError('NOT_FOUND', message);
}

export function forbidden(message = 'forbidden'): ServiceError {
  return new ServiceError('FORBIDDEN', message);
}

export function conflict(message: string): ServiceError {
  return new ServiceError('CONFLICT', message);
}

export function invalid(message: string): ServiceError {
  return new ServiceError('INVALID', message);
}

export function expired(message: string): ServiceError {
  return new ServiceError('EXPIRED', message);
}

export function unauthenticated(message: string): ServiceError {
  return new ServiceError('UNAUTHENTICATED', message);
}
