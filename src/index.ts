import { DurableObject } from 'cloudflare:workers';
import Swarm from './lib/swarm.js';
import parseWebSocketRequest from './lib/parse-websocket.js';
import * as common from './lib/common-node.js';
import { hex2bin } from 'uint8-util';
import string2compact from 'string2compact';

export interface Env {
	WEBSOCKET_SERVER: DurableObjectNamespace<TrackerObject>;
	SECRET_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

interface SocketAttachment {
	peerId: string | null;
	infoHashes: string[];
	ip: string;
	port: number;
	addr: string;
}

// Durable Object
// Implements: https://github.com/webtorrent/bittorrent-tracker/blob/master/server.js
export class TrackerObject extends DurableObject {
	intervalMs: number = 2 * 60 * 1000;
	torrents: Record<string, any> = {};
	_filter?: (infoHash: string, params: any, cb: (err?: any) => void) => void;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		let ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
		let port = 0;
		let addr = `${ip}:${port}`;

		this.ctx.acceptWebSocket(server);

		server.serializeAttachment({
			peerId: null,
			infoHashes: [],
			ip,
			port,
			addr,
		} as SocketAttachment);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		let attachment = ws.deserializeAttachment() as SocketAttachment;

		// inject connection info into ws so parseWebSocketRequest finds them
		(ws as any).ip = attachment.ip;
		(ws as any).port = attachment.port;
		(ws as any).addr = attachment.addr;

		let params: any;
		try {
			params = parseWebSocketRequest(ws, {}, message as string);
		} catch (err: any) {
			ws.send(
				JSON.stringify({
					'failure reason': err.message,
				}),
			);
			console.warn('parseWebSocketRequest warning:', err);
			return;
		}

		if (!attachment.peerId) {
			attachment.peerId = params.peer_id; // as hex
			ws.serializeAttachment(attachment);
		}

		this._onRequest(params, ws, attachment, (err: any, response: any) => {
			if (err) {
				ws.send(
					JSON.stringify({
						action: params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape',
						'failure reason': err.message,
						info_hash: hex2bin(params.info_hash),
					}),
				);
				console.warn('onRequest warning', err);
				return;
			}

			response.action = params.action === common.ACTIONS.ANNOUNCE ? 'announce' : 'scrape';

			let peers: any;
			if (response.action === 'announce') {
				peers = response.peers;
				delete response.peers;

				if (!attachment.infoHashes.includes(params.info_hash)) {
					attachment.infoHashes.push(params.info_hash);
					ws.serializeAttachment(attachment);
				}

				response.info_hash = hex2bin(params.info_hash);
				response.interval = Math.ceil(this.intervalMs / 1000 / 5);
			}

			if (!params.answer) {
				ws.send(JSON.stringify(response));
			}

			if (Array.isArray(params.offers)) {
				peers.forEach((peer: any, i: number) => {
					peer.socket.send(
						JSON.stringify({
							action: 'announce',
							offer: params.offers[i].offer,
							offer_id: params.offers[i].offer_id,
							peer_id: hex2bin(attachment.peerId!),
							info_hash: hex2bin(params.info_hash),
						}),
					);
				});
			}

			const done = () => {
				// Event emitters are not present natively in DOs.
				// Logic can be added here if needed.
			};

			if (params.answer) {
				this.getSwarm(params.info_hash, (err: any, swarm: any) => {
					if (err) return console.warn(err);
					if (!swarm) {
						return console.warn(new Error('no swarm with that `info_hash`'));
					}

					const toPeer = swarm.peers.get(params.to_peer_id);
					if (!toPeer) {
						return console.warn(new Error('no peer with that `to_peer_id`'));
					}

					toPeer.socket.send(
						JSON.stringify({
							action: 'announce',
							answer: params.answer,
							offer_id: params.offer_id,
							peer_id: hex2bin(attachment.peerId!),
							info_hash: hex2bin(params.info_hash),
						}),
					);

					done();
				});
			} else {
				done();
			}
		});
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		let attachment = ws.deserializeAttachment() as SocketAttachment | null;
		if (!attachment) return;

		if (attachment.peerId) {
			attachment.infoHashes.slice(0).forEach((infoHash) => {
				const swarm = this.torrents[infoHash];
				if (swarm) {
					swarm.announce({
						type: 'ws',
						event: 'stopped',
						numwant: 0,
						peer_id: attachment!.peerId,
					});
				}
			});
		}

		attachment.peerId = null;
		attachment.infoHashes = [];
		ws.serializeAttachment(attachment);
	}

	async webSocketError(ws: WebSocket, error: unknown) {
		console.warn('websocket error', error);
		await this.webSocketClose(ws, 1006, 'Error', false);
	}

	_onRequest(params: any, ws: WebSocket, attachment: SocketAttachment, cb: (err: any, response?: any) => void) {
		if (params && params.action === common.ACTIONS.CONNECT) {
			cb(null, { action: common.ACTIONS.CONNECT });
		} else if (params && params.action === common.ACTIONS.ANNOUNCE) {
			this._onAnnounce(params, ws, attachment, cb);
		} else if (params && params.action === common.ACTIONS.SCRAPE) {
			this._onScrape(params, cb);
		} else {
			cb(new Error('Invalid action'));
		}
	}

	getSwarm(infoHash: string, cb: (err: any, swarm?: any) => void) {
		cb(null, this.torrents[infoHash]);
	}

	createSwarm(infoHash: string, cb: (err: any, swarm?: any) => void) {
		let swarm = new Swarm(infoHash, this);
		this.torrents[infoHash] = swarm;
		cb(null, swarm);
	}

	_onAnnounce(params: any, ws: WebSocket, attachment: SocketAttachment, cb: (err: any, response?: any) => void) {
		const self = this;

		if (this._filter) {
			this._filter(params.info_hash, params, (err) => {
				if (err) return cb(err);
				getOrCreateSwarm((err: any, swarm: any) => {
					if (err) return cb(err);
					announce(swarm);
				});
			});
		} else {
			getOrCreateSwarm((err: any, swarm: any) => {
				if (err) return cb(err);
				announce(swarm);
			});
		}

		function getOrCreateSwarm(cb: (err: any, swarm?: any) => void) {
			self.getSwarm(params.info_hash, (err: any, swarm: any) => {
				if (err) return cb(err);
				if (swarm) return cb(null, swarm);
				self.createSwarm(params.info_hash, (err: any, swarm: any) => {
					if (err) return cb(err);
					cb(null, swarm);
				});
			});
		}

		function announce(swarm: any) {
			if (!params.event || params.event === 'empty') params.event = 'update';
			swarm.announce(params, (err: any, response: any) => {
				if (err) return cb(err);

				if (!response.action) response.action = common.ACTIONS.ANNOUNCE;
				if (!response.interval) response.interval = Math.ceil(self.intervalMs / 1000);

				if (params.compact === 1) {
					const peers = response.peers;
					response.peers = string2compact(
						peers.filter((peer: any) => common.IPV4_RE.test(peer.ip)).map((peer: any) => `${peer.ip}:${peer.port}`),
					);
					response.peers6 = string2compact(
						peers.filter((peer: any) => common.IPV6_RE.test(peer.ip)).map((peer: any) => `[${peer.ip}]:${peer.port}`),
					);
				} else if (params.compact === 0) {
					response.peers = response.peers.map((peer: any) => ({
						'peer id': hex2bin(peer.peerId),
						ip: peer.ip,
						port: peer.port,
					}));
				}

				cb(null, response);
			});
		}
	}

	_onScrape(params: any, cb: (err: any, response?: any) => void) {
		let infoHashes: string[];
		if (params.info_hash != null) {
			infoHashes = params.info_hash;
		} else if (params.app_id != null) {
			// Only the swarms whose info hash belongs to this app.
			infoHashes = Object.keys(this.torrents).filter((infoHash) => hex2bin(infoHash).slice(0, -5) === params.app_id);
		} else {
			infoHashes = Object.keys(this.torrents);
		}

		const response: any = {
			action: common.ACTIONS.SCRAPE,
			// Lobbies are live swarms grouped by app_id; each value lists the
			// current session ids. Derived from swarms, never tracked separately.
			lobbies: {} as Record<string, string[]>,
			flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) },
		};

		infoHashes.forEach((hexInfoHash: string) => {
			const swarm = this.torrents[hexInfoHash];
			const peerCount = swarm ? swarm.peers.keys.length : 0;

			// Reclaim empty swarms so dead lobbies don't linger in memory, and
			// skip them so we never send a lobby with no connected peers.
			if (peerCount === 0) {
				delete this.torrents[hexInfoHash];
				return;
			}

			// The session id is always the last 5 characters.
			// TODO: Possibly default to 5, but allow a parameter for custom length.
			const infoHash = hex2bin(hexInfoHash);
			const appId = infoHash.slice(0, -5);
			const sessionId = infoHash.slice(-5);

			if (!response.lobbies[appId]) response.lobbies[appId] = [];
			response.lobbies[appId].push(sessionId);
		});

		cb(null, response);
	}
}
