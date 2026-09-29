/**
 * @module utils/errors
 * @description Custom error types for the Email AI Agent.
 * All errors extend a base AppError for consistent error handling.
 */

/** Base application error with error code and context */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** LLM provider errors */
export class LLMError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'LLM_ERROR', 502, true, context);
    this.name = 'LLMError';
  }
}

/** LLM rate limit error */
export class LLMRateLimitError extends LLMError {
  public readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message, { retryAfterMs });
    this.name = 'LLMRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Email provider connection errors */
export class ProviderConnectionError extends AppError {
  public readonly provider: string;
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    super(message, 'PROVIDER_CONNECTION_ERROR', 503, true, { provider, ...context });
    this.name = 'ProviderConnectionError';
    this.provider = provider;
  }
}

/** Provider authentication errors */
export class ProviderAuthError extends AppError {
  public readonly provider: string;
  constructor(provider: string, message: string) {
    super(message, 'PROVIDER_AUTH_ERROR', 401, true, { provider });
    this.name = 'ProviderAuthError';
    this.provider = provider;
  }
}

/** Email not found error */
export class EmailNotFoundError extends AppError {
  constructor(emailId: string, accountId?: string) {
    super(
      `Email not found: ${emailId}${accountId ? ` in account ${accountId}` : ''}`,
      'EMAIL_NOT_FOUND',
      404,
      true,
      { emailId, accountId }
    );
    this.name = 'EmailNotFoundError';
  }
}

/** Configuration errors */
export class ConfigError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', 500, true, context);
    this.name = 'ConfigError';
  }
}

/** Validation errors */
export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, true, context);
    this.name = 'ValidationError';
  }
}

/** Cache errors */
export class CacheError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CACHE_ERROR', 500, true, context);
    this.name = 'CacheError';
  }
}

/** Tool execution errors */
export class ToolExecutionError extends AppError {
  public readonly toolName: string;
  constructor(toolName: string, message: string, context?: Record<string, unknown>) {
    super(message, 'TOOL_EXECUTION_ERROR', 500, true, { toolName, ...context });
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

/**
 * Type guard for AppError.
 * Useful for distinguishing operational vs programmer errors.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Safely extract error message from unknown error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unknown error occurred';
}
