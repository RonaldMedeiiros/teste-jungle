import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import {
  DomainError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from './errors';
import { AppLogger } from './logger';

interface ErrorBody {
  error: string;
  message: string;
  failureCode?: string;
  details?: unknown;
  retriable: boolean;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error('request failed', { status, error: body.error, message: body.message });
    }

    response.status(status).json(body);
  }

  private describe(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof InvalidRequestError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { error: exception.code, message: exception.message, details: exception.details, retriable: false },
      };
    }

    if (exception instanceof IdempotencyConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { error: exception.code, message: exception.message, retriable: false },
      };
    }

    if (exception instanceof WalletAlreadyExistsError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { error: exception.code, message: exception.message, retriable: false },
      };
    }

    if (exception instanceof WalletNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        body: {
          error: exception.code,
          message: exception.message,
          failureCode: exception.failureCode,
          retriable: false,
        },
      };
    }

    if (exception instanceof TransactionNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        body: { error: exception.code, message: exception.message, retriable: false },
      };
    }

    if (exception instanceof TransientFailureError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { error: exception.code, message: exception.message, retriable: true },
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { error: exception.code, message: exception.message, retriable: false },
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: { error: 'HTTP_ERROR', message: exception.message, retriable: false },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'INTERNAL_ERROR', message: 'unexpected failure', retriable: true },
    };
  }
}
