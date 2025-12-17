import * as vscode from "vscode";
import WebSocket from "ws";
import { EventEmitter } from "events";
import { xorBuffer } from "./xor";
import { RelayMessage, RelayRPCRequest, RelayRPCResponses } from "../types";
import os from "os";

export function encode(data: RelayRPCRequest, encryptionKey: string | null): string {
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
): RelayRPCResponses | Buffer<ArrayBufferLike> {
	const raw = isBinary
		? Buffer.isBuffer(data) ? data : Buffer.from(data)
		: Buffer.from(data as string, "base64");

	if (!encryptionKey || encryptionKey.length === 0) {
		return isBinary ? raw : JSON.parse(raw.toString("utf8"));
	}

	const decrypted = xorBuffer(raw, encryptionKey);
	return isBinary ? decrypted : JSON.parse(decrypted.toString("utf8"));
}

function parseMessage(data: string): RelayMessage | null {
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}

export class RelayClient extends EventEmitter {
	private ws!: WebSocket;
	private requestId = 1;
	private connected = false;
	private heartbeat?: NodeJS.Timeout;
	private lastPong = Date.now();
	private pending = new Map<number, (v: RelayRPCResponses) => void>();
	private serverName = "";
	private encryptionKey: string | null = null;
	private pendingStreams = new Map<number, { onChunk: (chunk: Buffer<ArrayBufferLike>) => void, onEnd: () => void }>();
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
					serverPassword: password,
					clientName: os.userInfo().username || "Unknown"
				});

				this.heartbeat = setInterval(() => {
					if (Date.now() - this.lastPong > 30000) {
						console.warn("Heartbeat requestTimeout, terminating");
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
				if (isBinary) {
					if (!this.pendingBinaryChunk) {
						console.error("We received a binary chunk but we don't have a pending binary chunk!");
						return;
					}

					const { requestId } = this.pendingBinaryChunk;
					this.pendingBinaryChunk = null;

					const handler = this.pendingStreams.get(requestId);

					if (!handler) {
						console.error("We received a binary chunk but we don't have a pending binary chunk handler!");
						return;
					}

					const raw = Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer);
					const binaryChunkData = decode(raw, this.encryptionKey, true);

					return handler.onChunk(binaryChunkData as Buffer<ArrayBufferLike>);
				}

				let msg: RelayMessage | null = parseMessage(d.toString());

				if (!msg) {
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
					vscode.window.showInformationMessage("Connected to server");

					this.serverName = msg.serverName;
					fullyConnected = true;

					this.emit("connected");

					if (!settled) {
						settled = true;
						resolve();
					}

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
						const obj = decode(msg.response, this.encryptionKey);

						this.pending.delete(msg.requestId);
						cb(obj as RelayRPCResponses);
					}
				}
			});

			this.ws.on("close", () => {
				this.connected = false;

				this.emit("disconnected");

				if (this.heartbeat) {
					clearInterval(this.heartbeat);
				}

				for (const [requestId, cb] of this.pending) {
					cb({ success: false, error_code: "connection_lost", requestId });
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

	send(obj: RelayMessage) {
		if (!this.connected) {
			return;
		}

		this.ws.send(JSON.stringify(obj));
	}

	rpc(action: string, payload: RelayRPCRequest): Promise<RelayRPCResponses> {
		if (!this.connected) {
			return Promise.reject(new Error("Not connected"));
		}

		const currentRequestId = this.requestId++;

		return new Promise((resolve, reject) => {
			const requestTimeout = setTimeout(() => {
				this.pending.delete(currentRequestId);
				reject({ success: false, error_code: "connection_lost", requestId: currentRequestId });
			}, 15000);

			this.pending.set(currentRequestId, (data: RelayRPCResponses) => {
				clearTimeout(requestTimeout);
				resolve({ ...data, requestId: currentRequestId });
			});

			this.send({
				type: "client_rpc",
				requestId: currentRequestId,
				action,
				payload: encode(payload, this.encryptionKey)
			});
		});
	}

	stream(requestId: number, onChunk: (chunk: Buffer) => void, onEnd: () => void) {
		this.pendingStreams.set(requestId, { onChunk, onEnd });
	}

	streamFillBuffer(requestId: number, buffer: Buffer<ArrayBufferLike>[] | Uint8Array[]): Promise<void> {
		return new Promise((resolve) => this.stream(requestId, (chunk) => buffer.push(chunk), () => resolve()));
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
