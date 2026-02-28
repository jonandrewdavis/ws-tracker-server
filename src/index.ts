import { DurableObject } from "cloudflare:workers";

export interface Env {
	WEBSOCKET_SERVER: DurableObjectNamespace<LobbyObject>;
	SECRET_KEY: string;
	TURN_KEY: string;
	ASSETS: any;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Expect to receive a WebSocket Upgrade request.
		// If there is one, accept the request and return a WebSocket Response.
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Durable Object expected Upgrade: websocket', {
				status: 426,
			});
		}

		let id = env.WEBSOCKET_SERVER.idFromName('foo');
		let stub = env.WEBSOCKET_SERVER.get(id);

		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// Durable Object
export class LobbyObject extends DurableObject {
	secretKey: string;
	currentlyConnectedWebSockets: number;
	turnKey: string;

	constructor(ctx: DurableObjectState, env: Env) {
		// This is reset whenever the constructor runs because
		// regular WebSockets do not survive Durable Object resets.
		super(ctx, env);
		this.currentlyConnectedWebSockets = 0;
		this.secretKey = env.SECRET_KEY;
		this.turnKey = env.TURN_KEY;
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `accept()` tells the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		server.accept();
		this.currentlyConnectedWebSockets += 1;

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}
}
