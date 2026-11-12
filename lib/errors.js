/** Error with a stable machine-readable code and an HTTP status for routes. */
export class InboxError extends Error {
  /**
   * @param {string} code stable identifier, e.g. `path-not-empty`
   * @param {string} message human-readable detail
   * @param {number} [status] HTTP status used by routes (default 422)
   */
  constructor(code, message, status = 422) {
    super(message)
    this.name = 'InboxError'
    this.code = code
    this.status = status
  }
}

/** Normalize any thrown value to `{ code, message }`. */
export function errorInfo(error) {
  if (error instanceof InboxError) return { code: error.code, message: error.message }
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message }
}
