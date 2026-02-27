import { DurableObject } from "cloudflare:workers";
import { Server } from 'bittorrent-tracker'

const CONFIG_PORT = 80;

export interface Env {
	TRACKER_OBJECT: DurableObjectNamespace<TrackerObject>;
	SECRET_KEY: string;
	TURN_KEY: string;
}

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class TrackerObject extends DurableObject {
	secretKey: string;
	turnKey: string;

	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.secretKey = env.SECRET_KEY || '9317e4d6-83b3-4188-94c4-353a2798d3c1';
		this.turnKey = env.TURN_KEY;
	}

	async fetch(request: Request): Promise<Response> {
		const server = Server.new({
			udp: false, // enable udp server? [default=true]
			http: false, // enable http server? [default=true]
			ws: true, // enable websocket server? [default=true]
			stats: true, // enable web-based statistics? [default=true]
			trustProxy: false, // enable trusting x-forwarded-for header for remote IP [default=false]
			filter: function (infoHash: string, params: any, cb: (err: Error | null) => void) {
				// Blacklist/whitelist function for allowing/disallowing torrents. If this option is
				// omitted, all torrents are allowed. It is possible to interface with a database or
				// external system before deciding to allow/deny, because this function is async.

				// It is possible to block by peer id (whitelisting torrent clients) or by secret
				// key (private trackers). Full access to the original HTTP/UDP request parameters
				// are available in `params`.

				// This example only allows one torrent.

				// const allowed = (infoHash === 'aaa67059ed6bd08362da625b3ae77f6f4a075aaa')
				// if (allowed) {
				//     // If the callback is passed `null`, the torrent will be allowed.
				//     cb(null)
				// } else {
				//     // If the callback is passed an `Error` object, the torrent will be disallowed
				//     // and the error's `message` property will be given as the reason.
				//     cb(new Error('disallowed torrent'))
				// }

				cb(null)
			}
		})
		// // start tracker server listening! Use 0 to listen on a random free port.
		const port = CONFIG_PORT
		const hostname = "localhost"

		server.on('error', function (err: Error) {
			// fatal server error!
			console.log(err.message)
		})

		server.on('warning', function (err: Error) {
			// client sent bad data. probably not a problem, just a buggy client.
			console.log(err.message)
		})

		server.on('listening', function () {
			// WS
			const wsAddr = server.ws.address()
			const wsHost = wsAddr.address !== '::' ? wsAddr.address : 'localhost'
			const wsPort = wsAddr.port
			console.log(`WebSocket tracker: ws://${wsHost}:${wsPort}`)
		})


		// // listen for individual tracker messages from peers:
		server.on('start', function (addr: string) {
			console.log('got start message from ' + addr)
		})

		server.on('complete', function (addr: string) { })
		server.on('update', function (addr: string) { })
		server.on('stop', function (addr: string) { })


		return new Response(null, {
			status: 101,
		});
	};
}



export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		// Expect to receive a WebSocket Upgrade request.
		// If there is one, accept the request and return a WebSocket Response.
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Durable Object expected Upgrade: websocket', {
				status: 426,
			});
		}

		// This example will refer to the same Durable Object,
		// since the name "foo" is hardcoded.
		let id = env.TRACKER_OBJECT.idFromName('foo');
		let stub = env.TRACKER_OBJECT.get(id);

		return stub.fetch(request);


	},
} satisfies ExportedHandler<Env>;
