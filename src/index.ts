import { DurableObject } from 'cloudflare:workers';
import Swarm from './lib/swarm.js';
import parseWebSocketRequest from './lib/parse-websocket.js';
import * as common from './lib/common-node.js';
import { hex2bin } from 'uint8-util';
import string2compact from 'string2compact';

export interface Env {
	WEBSOCKET_SERVER: DurableObjectNamespace<TrackerObject>;
	SECRET_KEY: string;
	TURN_KEY: string;
	ASSETS: any;
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
	private initialized = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Called once per DO lifetime (after hibernation wakeup or cold start).
	 * Rebuilds this.torrents from the WebSocket attachments that Cloudflare
	 * automatically persists through hibernation, so peer lookups keep working
	 * after the DO is evicted and restarted.
	 */
	private async _ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;

		// 1. Load all swarms from storage and filter out ones older than 2 hours
		const swarmsFromStorage = await this.ctx.storage.list<any>({ prefix: 'swarm:' });
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

		for (const [key, swarmState] of swarmsFromStorage.entries()) {
			const infoHash = swarmState.infoHash;

			if (swarmState.lastUpdated && swarmState.lastUpdated < twoHoursAgo) {
				console.log(`[cleanup] removing stale swarm ${infoHash} (last updated ${new Date(swarmState.lastUpdated).toISOString()})`);
				await this.ctx.storage.delete(key);
				continue;
			}

			if (!this.torrents[infoHash]) {
				this.torrents[infoHash] = new Swarm(infoHash, this);
			}
			const swarm = this.torrents[infoHash];
			swarm.complete = swarmState.complete;
			swarm.incomplete = swarmState.incomplete;

			// Populate peers
			if (Array.isArray(swarmState.peers)) {
				for (const p of swarmState.peers) {
					swarm.peers.set(p.peerId, {
						type: p.type,
						complete: p.complete,
						peerId: p.peerId,
						ip: p.ip,
						port: p.port,
						socket: null, // will be linked below if the WebSocket is active
					});
				}
			}
		}

		// 2. Get active WebSockets and link/merge them back into the restored swarms
		const sockets = this.ctx.getWebSockets();
		console.log(`[restore] rebuilding swarm state from ${sockets.length} hibernated socket(s)`);

		let shouldPersistChanges = false;
		for (const socket of sockets) {
			const attachment = socket.deserializeAttachment() as SocketAttachment | null;
			if (!attachment?.peerId || !attachment.infoHashes?.length) continue;

			// Re-inject connection info so the socket behaves normally
			(socket as any).ip = attachment.ip;
			(socket as any).port = attachment.port;
			(socket as any).addr = attachment.addr;

			for (const infoHash of attachment.infoHashes) {
				if (!this.torrents[infoHash]) {
					this.torrents[infoHash] = new Swarm(infoHash, this);
				}
				const swarm = this.torrents[infoHash];

				let peer = swarm.peers.get(attachment.peerId);
				if (!peer) {
					peer = {
						type: 'ws',
						complete: false, // unknown after restart; treated as incomplete
						peerId: attachment.peerId,
						ip: attachment.ip,
						port: attachment.port,
						socket,
					};
					swarm.peers.set(attachment.peerId, peer);
					swarm.incomplete += 1;
					shouldPersistChanges = true;
				} else {
					peer.socket = socket;
				}
			}
		}

		// If any new peers/swarms were added during WS reconciliation, persist those changes
		if (shouldPersistChanges) {
			for (const infoHash of Object.keys(this.torrents)) {
				await this.onSwarmChange(infoHash);
			}
		}

		// Log each restart and the current count of torrents and connections during restart
		console.log(`[restart] Durable Object restarted. Current torrents: ${Object.keys(this.torrents).length}, Current connections: ${sockets.length}`);
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
		await this._ensureInitialized();
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
					if (peer.socket) {
						peer.socket.send(
							JSON.stringify({
								action: 'announce',
								offer: params.offers[i].offer,
								offer_id: params.offers[i].offer_id,
								peer_id: hex2bin(attachment.peerId!),
								info_hash: hex2bin(params.info_hash),
							}),
						);
					}
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

					if (toPeer.socket) {
						toPeer.socket.send(
							JSON.stringify({
								action: 'announce',
								answer: params.answer,
								offer_id: params.offer_id,
								peer_id: hex2bin(attachment.peerId!),
								info_hash: hex2bin(params.info_hash),
							}),
						);
					} else {
						console.warn(new Error('to_peer socket is not active'));
					}

					done();
				});
			} else {
				done();
			}
		});
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		await this._ensureInitialized();
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
		this.onSwarmChange(infoHash)
			.then(() => cb(null, swarm))
			.catch((err) => cb(err));
	}

	async removeSwarm(infoHash: string): Promise<void> {
		delete this.torrents[infoHash];
		await this.ctx.storage.delete(`swarm:${infoHash}`);
		console.log(`[cleanup] removed empty swarm ${infoHash} from memory and storage`);
	}

	async onSwarmChange(infoHash: string): Promise<void> {
		const swarm = this.torrents[infoHash];
		if (!swarm) {
			await this.ctx.storage.delete(`swarm:${infoHash}`);
			return;
		}

		if (swarm.peers.length === 0) {
			await this.removeSwarm(infoHash);
			return;
		}

		const peerList: any[] = [];
		for (const key of swarm.peers.keys) {
			const peer = swarm.peers.peek(key);
			if (peer) {
				peerList.push({
					type: peer.type,
					complete: peer.complete,
					peerId: peer.peerId,
					ip: peer.ip,
					port: peer.port,
				});
			}
		}

		await this.ctx.storage.put(`swarm:${infoHash}`, {
			infoHash: swarm.infoHash,
			complete: swarm.complete,
			incomplete: swarm.incomplete,
			peers: peerList,
			lastUpdated: Date.now(),
		});
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
		if (params.info_hash == null) {
			params.info_hash = Object.keys(this.torrents);
		}

		Promise.all(
			params.info_hash.map((infoHash: string) => {
				return new Promise((resolve, reject) => {
					this.getSwarm(infoHash, (err: any, swarm: any) => {
						if (err) return reject(err);
						if (swarm) {
							swarm.scrape(params, (err: any, scrapeInfo: any) => {
								if (err) return reject(err);
								resolve({
									infoHash,
									complete: (scrapeInfo && scrapeInfo.complete) || 0,
									incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0,
								});
							});
						} else {
							resolve({ infoHash, complete: 0, incomplete: 0 });
						}
					});
				});
			}),
		)
			.then((results: any[]) => {
				const response: any = {
					action: common.ACTIONS.SCRAPE,
					files: {},
					flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) },
				};

				results.forEach((result: any) => {
					response.files[hex2bin(result.infoHash)] = {
						complete: result.complete || 0,
						incomplete: result.incomplete || 0,
						downloaded: result.complete || 0,
					};
				});

				cb(null, response);
			})
			.catch((err) => {
				cb(err);
			});
	}
}
