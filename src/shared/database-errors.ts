const UNIQUE_VIOLATION = '23505';
const LOCK_NOT_AVAILABLE = '55P03';
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

const CONNECTION_CODES = new Set(['08000', '08003', '08006', '08001', '08004', '57P01', '57P03', '53300']);

function findCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  return candidate.cause ? findCode(candidate.cause) : undefined;
}

function findConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { constraint?: unknown; cause?: unknown };
  if (typeof candidate.constraint === 'string') {
    return candidate.constraint;
  }
  return candidate.cause ? findConstraint(candidate.cause) : undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (findCode(error) !== UNIQUE_VIOLATION) {
    return false;
  }
  return constraint ? findConstraint(error) === constraint : true;
}

export function isLockConflict(error: unknown): boolean {
  const code = findCode(error);
  return code === LOCK_NOT_AVAILABLE || code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = findCode(error);
  if (!code) {
    return false;
  }
  return CONNECTION_CODES.has(code) || isLockConflict(error);
}
