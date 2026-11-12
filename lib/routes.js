/**
 * HTTP routes on `ctx.connection.fetch` (authenticated by the DSH gateway).
 * Exact paths only; ids travel in the query string or JSON body and are
 * validated against strict patterns by the store before touching disk.
 */

import { errorInfo, InboxError } from './errors.js'

export const ROUTES = {
  session: '/api/dsh-inbox/session',
  proposal: '/api/dsh-inbox/proposal',
  latest: '/api/dsh-inbox/proposal/latest',
  create: '/api/dsh-inbox/proposal/create',
  repropose: '/api/dsh-inbox/proposal/repropose',
  opened: '/api/dsh-inbox/proposal/opened',
}

const MAX_BODY = 16 * 1024

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorResponse(error, log) {
  const info = errorInfo(error)
  const status = error instanceof InboxError ? error.status : 500
  if (status >= 500) log?.(`route error: ${info.code} ${info.message}`)
  return jsonResponse({ error: info }, status)
}

async function readBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new InboxError('body-too-large', 'Request body too large.', 413)
  if (text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new InboxError('bad-json', 'Request body must be JSON.', 400)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InboxError('bad-json', 'Request body must be a JSON object.', 400)
  }
  return value
}

/**
 * @param {object} options
 * @param {import('./proposal.js').InboxService} options.service
 * @param {() => Promise<{ sessionId: string, cwd: string }>} options.createSession
 * @param {(message: string) => void} [options.log]
 */
export function createHandlers({ service, createSession, log }) {
  const wrap = fn => async request => {
    try {
      return jsonResponse(await fn(request))
    } catch (error) {
      return errorResponse(error, log)
    }
  }
  return {
    session: wrap(async () => createSession()),
    proposal: wrap(async request => {
      const url = new URL(request.url, 'http://localhost')
      return service.view(url.searchParams.get('sessionId') ?? '', url.searchParams.get('proposalId') ?? '')
    }),
    latest: wrap(async request => {
      const url = new URL(request.url, 'http://localhost')
      return { proposal: await service.latest(url.searchParams.get('sessionId') ?? '') }
    }),
    create: wrap(async request => {
      const body = await readBody(request)
      return service.create(body.sessionId, body.proposalId, { writeAgents: body.writeAgents !== false })
    }),
    repropose: wrap(async request => {
      const body = await readBody(request)
      return service.repropose(body.sessionId, body.proposalId)
    }),
    opened: wrap(async request => {
      const body = await readBody(request)
      return service.markOpened(body.sessionId, body.proposalId, body.projectSessionId)
    }),
  }
}

/** Register all routes; returns one disposer. Rolls back on partial failure. */
export function installRoutes(connection, handlers) {
  const table = [
    { path: ROUTES.session, methods: ['POST'], fetch: handlers.session },
    { path: ROUTES.proposal, methods: ['GET'], fetch: handlers.proposal },
    { path: ROUTES.latest, methods: ['GET'], fetch: handlers.latest },
    { path: ROUTES.create, methods: ['POST'], fetch: handlers.create },
    { path: ROUTES.repropose, methods: ['POST'], fetch: handlers.repropose },
    { path: ROUTES.opened, methods: ['POST'], fetch: handlers.opened },
  ]
  const disposers = []
  try {
    for (const route of table) disposers.push(connection.fetch.register({ ...route, requestBody: 'buffered' }))
  } catch (error) {
    for (const dispose of disposers) {
      try { dispose() } catch { /* nothing more to do */ }
    }
    throw error
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
