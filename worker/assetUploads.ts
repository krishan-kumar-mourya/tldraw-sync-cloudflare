import { IRequest, error } from 'itty-router'
import { Environment } from './types'

// Larger files are refused. A pasted screenshot is well under this.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// assets are stored in the bucket under uploads/{roomId}/, so a room's
// uploads can only be reached with a token for that room. The room id is
// checked in worker.ts before we get here.
function getAssetObjectName(roomId: string, uploadId: string) {
	return `uploads/${roomId}/${uploadId.replace(/[^a-zA-Z0-9\_\-]+/g, '_')}`
}

// when a user uploads an asset, we store it in the bucket. we only allow image and video assets.
export async function handleAssetUpload(request: IRequest, env: Environment) {
	const objectName = getAssetObjectName(request.params.roomId, request.params.uploadId)

	const contentType = request.headers.get('content-type') ?? ''
	if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
		return error(400, 'Invalid content type')
	}

	// The size has to be known up front: R2 needs it, and it is how we refuse
	// large files without reading them.
	const size = Number(request.headers.get('content-length'))
	if (!size) return error(411, 'Content-Length required')
	if (size > MAX_UPLOAD_BYTES) return error(413, 'File too large')

	if (await env.TLDRAW_BUCKET.head(objectName)) {
		return error(409, 'Upload already exists')
	}

	await env.TLDRAW_BUCKET.put(objectName, request.body, {
		httpMetadata: { contentType },
	})

	return { ok: true }
}

// when a user downloads an asset, we retrieve it from the bucket. we also cache the response for performance.
export async function handleAssetDownload(
	request: IRequest,
	env: Environment,
	ctx: ExecutionContext
) {
	const objectName = getAssetObjectName(request.params.roomId, request.params.uploadId)

	// if we have a cached response for this request (automatically handling ranges etc.), return it.
	// The token is left out of the key: it changes, the file does not, and the
	// token was already checked in worker.ts.
	const cacheUrl = new URL(request.url)
	cacheUrl.search = ''
	const cacheKey = new Request(cacheUrl.toString(), { headers: request.headers })
	const cachedResponse = await caches.default.match(cacheKey)
	if (cachedResponse) {
		return cachedResponse
	}

	// if not, we try to fetch the asset from the bucket
	const object = await env.TLDRAW_BUCKET.get(objectName, {
		range: request.headers,
		onlyIf: request.headers,
	})

	if (!object) {
		return error(404)
	}

	// write the relevant metadata to the response headers
	const headers = new Headers()
	object.writeHttpMetadata(headers)

	// assets are immutable, so we can cache them basically forever. ("public"
	// is needed for the worker's own cache to keep it; that cache is only read
	// after the room token has been checked.)
	headers.set('cache-control', 'public, max-age=31536000, immutable')
	headers.set('etag', object.httpEtag)
	// An uploaded SVG opened on its own must not run scripts.
	headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	headers.set('x-content-type-options', 'nosniff')

	// CORS headers are added in worker.ts, for our own origins only.

	// cloudflare doesn't set the content-range header automatically in writeHttpMetadata, so we
	// need to do it ourselves.
	let contentRange
	if (object.range) {
		if ('suffix' in object.range) {
			const start = object.size - object.range.suffix
			const end = object.size - 1
			contentRange = `bytes ${start}-${end}/${object.size}`
		} else {
			const start = object.range.offset ?? 0
			const end = object.range.length ? start + object.range.length - 1 : object.size - 1
			if (start !== 0 || end !== object.size - 1) {
				contentRange = `bytes ${start}-${end}/${object.size}`
			}
		}
	}

	if (contentRange) {
		headers.set('content-range', contentRange)
	}

	// make sure we get the correct body/status for the response
	const body = 'body' in object && object.body ? object.body : null
	const status = body ? (contentRange ? 206 : 200) : 304

	// we only cache complete (200) responses
	if (status === 200) {
		const [cacheBody, responseBody] = body!.tee()
		ctx.waitUntil(caches.default.put(cacheKey, new Response(cacheBody, { headers, status })))
		return new Response(responseBody, { headers, status })
	}

	return new Response(body, { headers, status })
}
