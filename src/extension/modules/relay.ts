import * as vscode from "vscode";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { xorBuffer } from "./xor";

export function encode(data: any, encryptionKey: string | null): string {
	const jsonBuf = Buffer.from(JSON.stringify(data), "utf8");

	if (!encryptionKey || encryptionKey.length === 0) {
		return jsonBuf.toString("base64");
	}

	const encrypted = xorBuffer(jsonBuf, encryptionKey);
	return encrypted.toString("base64");
}

export function decode(
	data: string | Buffer,
	encryptionKey: string | null,
	isBinary = false
): any {
	const raw = isBinary
		? Buffer.isBuffer(data) ? data : Buffer.from(data)
		: Buffer.from(data as string, "base64");

	if (!encryptionKey || encryptionKey.length === 0) {
		return isBinary ? raw : JSON.parse(raw.toString("utf8"));
	}

	const decrypted = xorBuffer(raw, encryptionKey);
	return isBinary ? decrypted : JSON.parse(decrypted.toString("utf8"));
}

export class RelayClient extends EventEmitter {
	private ws!: WebSocket;
	private requestId = 1;
	private connected = false;
	private heartbeat?: NodeJS.Timeout;
	private lastPong = Date.now();
	private pending = new Map<number, (v: any) => void>();
	private serverName = "";
	private encryptionKey: string | null = null;
	private pendingStreams = new Map<number, { onChunk: (chunk: any) => void, onEnd: () => void }>();
	private dontAttemptToReconnect = false;

	private pendingBinaryChunk:
		| { requestId: number }
		| null = null;

	constructor() {
		super();
	}

	async connect(url: string, address: string, password: string, encryptionKey: string | null) {
		this.encryptionKey = encryptionKey;

		this.emit("connecting");

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let fullyConnected = false;

			this.ws = new WebSocket(url, {
				headers: { "Sec-WebSocket-Protocol": "gmsv_remote" }
			});

			this.ws.on("open", () => {
				this.connected = true;
				this.lastPong = Date.now();

				this.send({
					type: "client_hello",
					serverAddress: address,
					serverPassword: password
				});

				this.heartbeat = setInterval(() => {
					if (Date.now() - this.lastPong > 30000) {
						console.warn("Heartbeat timeout, terminating");
						this.ws.terminate();
					} else {
						try { this.ws.ping(); } catch { }
						this.send({ type: "ping" });
					}
				}, 10000);
			});

			this.ws.on("pong", () => {
				this.lastPong = Date.now();
			});

			this.ws.on("message", (d, isBinary) => {
				console.log("msg", d.toString());

				if (isBinary) {
					if (!this.pendingBinaryChunk) {
						return;
					}

					const { requestId } = this.pendingBinaryChunk;
					this.pendingBinaryChunk = null;

					const handler = this.pendingStreams.get(requestId);

					if (!handler) {
						return;
					}

					const raw = Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer);
					const binaryChunkData = decode(raw, this.encryptionKey, true);

					handler.onChunk(binaryChunkData);
					return;
				}

				let msg: any;

				try {
					msg = JSON.parse(d.toString());
				} catch {
					console.error("Invalid JSON:", d.toString());
					return;
				}

				if (msg.type === "pong") {
					this.lastPong = Date.now();
					return;
				}

				if (msg.type === "client_hello_failure") {
					vscode.window.showErrorMessage("Failed to connect to server. Ensure the server is running and the password is correct.");
					
					setTimeout(() => {
						if (this.dontAttemptToReconnect || this.connected) {
							return;
						}

						this.connect(url, address, password, encryptionKey);
					}, 5000);

					return;
				}

				if (msg.type === "server_update") {
					fullyConnected = true;
					vscode.window.showInformationMessage("Connected to server");
					this.serverName = msg.serverName;
					this.emit("connected");

					if (!settled) {
						settled = true;
						resolve();
					}

					return;
				}

				if (msg.type === "server_rpc_stream_start") {
					return;
				}

				if (msg.type === "server_rpc_stream_chunk") {
					this.pendingBinaryChunk = { requestId: msg.requestId };

					return;
				}

				if (msg.type === "server_rpc_stream_stop") {
					const handler = this.pendingStreams.get(msg.requestId);

					if (handler) {
						handler.onEnd();
						this.pendingStreams.delete(msg.requestId);
						this.pendingBinaryChunk = null;
					}

					return;
				}

				if (msg.type === "server_rpc_response") {
					const cb = this.pending.get(msg.requestId);

					if (cb) {
						const obj = decode(msg.response as string, this.encryptionKey);

						this.pending.delete(msg.requestId);
						cb(obj);
					}
				}
			});

			this.ws.on("close", () => {
				this.connected = false;

				this.emit("disconnected");

				if (this.heartbeat) {
					clearInterval(this.heartbeat);
				}

				for (const [, cb] of this.pending) {
					cb({ success: false, error: "Disconnected" });
				}

				this.pending.clear();

				if (!settled) {
					settled = true;
					reject(new Error("Socket closed during connect"));
				}

				if (!this.dontAttemptToReconnect && fullyConnected) {
					vscode.window.showErrorMessage("Connection lost, reconnecting...");

					setTimeout(() => {
						if (this.dontAttemptToReconnect || this.connected) {
							return;
						}

						this.connect(url, address, password, encryptionKey);
					}, 1500);
				}

				this.dontAttemptToReconnect = false;
			});

			this.ws.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}

	send(obj: any) {
		if (!this.connected) {
			return;
		}

		this.ws.send(JSON.stringify(obj));
	}

	rpc(action: string, payload: any): Promise<any> {
		if (!this.connected) {
			return Promise.reject(new Error("Not connected"));
		}

		const id = this.requestId++;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("RPC timeout"));
			}, 15000);

			this.pending.set(id, (data) => {
				clearTimeout(timeout);
				resolve(data);
			});

			this.send({
				type: "client_rpc",
				requestId: id,
				action,
				payload: encode(payload, this.encryptionKey)
			});
		});
	}

	getLastRequestId() {
		return this.requestId - 1;
	}

	stream(requestId: number, onChunk: (chunk: any) => void, onEnd: () => void) {
		this.pendingStreams.set(requestId, { onChunk, onEnd });
	}

	stopStream(requestId: number) {
		this.pendingStreams.delete(requestId);
	}

	name() {
		return this.serverName;
	}

	disconnect() {
		this.dontAttemptToReconnect = true;
		this.ws.close();
	}
}
