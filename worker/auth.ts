// Who may use a room. The PeerTeach backend hands each person a short-lived
// token for the one room they are allowed into (`whiteboard_token` from
// /student|teacher/remote-coaching/access). It is an HS256 JWT signed with
// WHITEBOARD_SECRET, which this worker shares with the backend:
//
//   { "room": "session_12-coach_7", "sub": "student-7", "exp": 1700000000 }

export interface RoomClaims {
	room: string
	sub: string
	exp: number
}

const encoder = new TextEncoder()

function base64UrlDecode(part: string): Uint8Array {
	const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
	const binary = atob(padded)
	return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function decodeJson(part: string): any {
	return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)))
}

/** The token's claims if it is genuine and still valid, otherwise null. */
export async function verifyRoomToken(
	token: string | null | undefined,
	secret: string | undefined,
	now = Date.now() / 1000
): Promise<RoomClaims | null> {
	if (!token || !secret) return null
	const parts = token.split('.')
	if (parts.length !== 3) return null
	const [header, payload, signature] = parts

	try {
		if (decodeJson(header).alg !== 'HS256') return null
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		)
		const genuine = await crypto.subtle.verify(
			'HMAC',
			key,
			base64UrlDecode(signature),
			encoder.encode(`${header}.${payload}`)
		)
		if (!genuine) return null

		const claims = decodeJson(payload)
		if (typeof claims.room !== 'string' || typeof claims.exp !== 'number') return null
		if (claims.exp <= now) return null
		return claims as RoomClaims
	} catch {
		return null
	}
}

/** The token from `?token=` (WebSockets and <img> cannot send headers) or a Bearer header. */
export function tokenFrom(request: Request): string | null {
	const fromQuery = new URL(request.url).searchParams.get('token')
	if (fromQuery) return fromQuery
	const header = request.headers.get('authorization') ?? ''
	return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
}

/** Whether the request carries a valid token for this room. */
export async function canUseRoom(request: Request, roomId: string, secret: string | undefined) {
	const claims = await verifyRoomToken(tokenFrom(request), secret)
	return !!claims && claims.room === roomId
}
