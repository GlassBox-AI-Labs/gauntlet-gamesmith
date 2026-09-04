export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export function success<T>(value: T): OperationResult<T> {
  return { ok: true, value }
}

export function failure(error: string): OperationResult<never> {
  return { ok: false, error }
}
