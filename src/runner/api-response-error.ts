import type { JsonValue } from '@graph/types.ts'

/** Keeps a received HTTP response available for safe diagnostic logging. */
export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly data: JsonValue,
  ) {
    super(message)
    this.name = 'ApiResponseError'
  }
}
