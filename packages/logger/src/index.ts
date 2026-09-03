import { pino } from 'pino';

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['*.apiKey', '*.api_key', '*.authorization', '*.token'],
  });
}
