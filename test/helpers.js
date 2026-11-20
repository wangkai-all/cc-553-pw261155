import { AppError, ConflictError, NotFoundError } from '../src/errors.js';

export { AppError, ConflictError, NotFoundError };

export function conflict(error) {
  return error instanceof ConflictError && error.status === 409;
}

export function notFound(error) {
  return error instanceof NotFoundError && error.status === 404;
}
