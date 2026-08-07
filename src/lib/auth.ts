import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import type { SessionUser } from './types'

const COOKIE_NAME = 'creatoros-session'
const MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  return new TextEncoder().encode(secret)
}

export async function signToken(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getJwtSecret())
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    return payload as unknown as SessionUser
  } catch {
    return null
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifyToken(token)
}

export function sessionCookieOptions(token: string) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: MAX_AGE,
    path: '/',
  }
}

export function clearCookieOptions() {
  return {
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 0,
    path: '/',
  }
}

/**
 * Helper for API routes: requires a session, optionally requires Admin role.
 * Returns the session, or null+httpStatus to reject.
 */
export async function requireSession(opts: { adminOnly?: boolean } = {}) {
  const session = await getSession()
  if (!session) return { session: null as null, error: 'Unauthorized' as const, status: 401 as const }
  if (opts.adminOnly && session.role !== 'Admin') {
    return { session: null as null, error: 'Forbidden' as const, status: 403 as const }
  }
  return { session, error: null, status: 200 as const }
}
