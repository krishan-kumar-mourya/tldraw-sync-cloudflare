// the contents of the environment should mostly be determined by wrangler.toml. These entries match
// the bindings defined there.
export interface Environment {
	TLDRAW_BUCKET: R2Bucket
	TLDRAW_DURABLE_OBJECT: DurableObjectNamespace
	// Shared with the PeerTeach backend, which signs room tokens with it.
	// Set with `wrangler secret put WHITEBOARD_SECRET` (locally: .dev.vars).
	WHITEBOARD_SECRET: string
	// Comma-separated origins allowed to use the board, e.g.
	// "https://app.peerteach.org". Set per environment in wrangler.toml.
	ALLOWED_ORIGINS: string
}
