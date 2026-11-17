import { AutoRouter, error, IRequest } from 'itty-router'
import { canUseRoom } from './auth'
import { handleAssetDownload, handleAssetUpload } from './assetUploads'
import { Environment } from './types'

// make sure our sync durable object is made available to cloudflare
export { TldrawDurableObject } from './TldrawDurableObject'

// Every route takes a room token from the PeerTeach backend (see auth.ts).
// Rooms are named by the backend, e.g. "session_12-coach_7".
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/

function allowedOrigins(env: Environment) {
	return (env.ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean)
}

// Requests without an Origin (an <img> from the same tab, curl) still need a
// token; the origin check only stops other websites using a leaked token.
function originAllowed(request: Request, env: Environment) {
	const origin = request.headers.get('origin')
	return !origin || allowedOrigins(env).includes(origin)
}

function corsHeaders(request: Request, env: Environment): Record<string, string> {
	const origin = request.headers.get('origin')
	if (!origin || !allowedOrigins(env).includes(origin)) return {}
	return {
		'access-control-allow-origin': origin,
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': 'authorization, content-type',
		'access-control-max-age': '86400',
		vary: 'Origin',
	}
}

function withCors(response: Response, request: Request, env: Environment) {
	// A WebSocket upgrade cannot have its headers changed, and needs no CORS.
	if (response.status === 101) return response
	const headers = corsHeaders(request, env)
	if (!Object.keys(headers).length) return response
	const copy = new Response(response.body, response)
	for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
	return copy
}

async function guard(request: IRequest, env: Environment) {
	const { roomId } = request.params
	if (!ROOM_ID.test(roomId)) return error(400, 'Invalid room')
	if (!originAllowed(request, env)) return error(403, 'Origin not allowed')
	if (!(await canUseRoom(request, roomId, env.WHITEBOARD_SECRET))) {
		return error(401, 'Not allowed in this room')
	}
}

const router = AutoRouter<IRequest, [env: Environment, ctx: ExecutionContext]>({
	before: [
		(request, env) => {
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: corsHeaders(request, env) })
			}
		},
	],
	finally: [(response, request, env) => withCors(response, request, env)],
	catch: (e) => {
		console.error(e)
		return error(500)
	},
})
	// requests to /connect are routed to the Durable Object, and handle realtime websocket syncing
	.get('/connect/:roomId', guard, (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})

	// Images pasted onto a board are stored under that board's room, and only
	// someone with a token for the room can add or fetch them.
	.post('/uploads/:roomId/:uploadId', guard, handleAssetUpload)
	.get('/uploads/:roomId/:uploadId', guard, handleAssetDownload)

// export our router for cloudflare
export default router
