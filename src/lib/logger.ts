/**
 * logger.ts — Minimal structured JSON logger.
 *
 * Writes newline-delimited JSON to stdout. Level is controlled by the
 * LOG_LEVEL environment variable (debug | info | warn | error).
 * Defaults to "info".
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
function currentLevel(): number {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}
function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < currentLevel()) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => write('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => write('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
