import type { IncomingHttpHeaders } from 'node:http'

/** Identity asserted by the fnOS unified gateway for an authenticated request. */
export interface Identity {
  /** Numeric NAS user id; the only identifier used for ownership. */
  readonly uid: string
  readonly username: string
  readonly isAdmin: boolean
}

const UID = /^[1-9][0-9]{0,9}$/

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Derive the caller identity from gateway headers.
 * The gateway overwrites these headers after authenticating the NAS session, so the
 * application never accepts an identity from a query parameter or request body.
 */
export function readIdentity(headers: IncomingHttpHeaders, devUid?: string): Identity | undefined {
  const rawUid = readHeader(headers, 'x-trim-userid') ?? devUid
  if (rawUid === undefined || !UID.test(rawUid)) return undefined

  const rawUsername = readHeader(headers, 'x-trim-username')
  const username = rawUsername === undefined || rawUsername.trim() === '' ? `user-${rawUid}` : rawUsername.trim()

  const rawAdmin = readHeader(headers, 'x-trim-isadmin')
  return { uid: rawUid, username, isAdmin: rawAdmin === 'true' }
}
