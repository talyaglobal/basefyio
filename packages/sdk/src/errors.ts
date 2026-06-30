export class BasefyioError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BasefyioError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApiError extends BasefyioError {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message, 'API_ERROR');
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends BasefyioError {
  constructor(message: string, public readonly cause: unknown) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}
