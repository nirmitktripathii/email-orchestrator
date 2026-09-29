/**
 * @module utils/logger  
 * @description Structured logging utility with level filtering and context support.
 * Outputs JSON-formatted logs to stderr (MCP servers must use stderr for logging).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel;
  private readonly context?: string;

  constructor(level: LogLevel = 'info', context?: string) {
    this.level = level;
    this.context = context;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(context: string): Logger {
    return new Logger(this.level, this.context ? `${this.context}:${context}` : context);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    const errorInfo = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error !== undefined
        ? { name: 'UnknownError', message: String(error) }
        : undefined;

    this.log('error', message, { ...data, ...(errorInfo ? { error: errorInfo } : {}) });
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(this.context ? { context: this.context } : {}),
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    // MCP servers MUST log to stderr (stdout is reserved for MCP protocol)
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}

/** Global logger instance */
export const logger = new Logger(
  (process.env['LOG_LEVEL'] as LogLevel) ?? 'info'
);

export { Logger };
export type { LogLevel };
