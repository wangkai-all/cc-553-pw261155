export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super(409, 'CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(method, path) {
    super(405, 'METHOD_NOT_ALLOWED', `不支持 ${method} ${path}`);
    this.name = 'MethodNotAllowedError';
  }
}
