import { Injectable } from '@nestjs/common';
import pino, { Logger } from 'pino';

const HIDDEN_KEYS = new Set(['password', 'secret', 'token', 'authorization', 'payload', 'body']);

@Injectable()
export class AppLogger {
  private readonly logger: Logger;

  constructor() {
    this.logger = pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
      base: { service: 'wagering-processor', instanceId: process.env['INSTANCE_ID'] ?? 'local' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    });
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.info(hide(fields), message);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.warn(hide(fields), message);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.logger.error(hide(fields), message);
  }
}

function hide(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = HIDDEN_KEYS.has(key) ? '[hidden]' : value;
  }
  return output;
}
