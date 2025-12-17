import { RelayClient } from "../modules/relay";
import type { RelayRPCResponseSearch, SearchChunk, SearchOptions } from "../types";

export function useSearchProvider(relay: RelayClient) {
	if (!globalThis.gmodSearchProvider) {
		globalThis.gmodSearchProvider = new SearchProvider(relay);
	}

	return globalThis.gmodSearchProvider;
}

export class SearchProvider {
	private searching: boolean = false;
	private onStart?: () => void;
	private onResultStream?: (chunk: SearchChunk[]) => void;
	private onEnd?: () => void;

	constructor(private relay: RelayClient) {
		this.relay = relay;
	}

	async search(query: string, options: SearchOptions) {
		const res: RelayRPCResponseSearch = await this.relay.rpc("FS.Search", {
			query,
			caseSensitive: options.caseSensitive,
			useRegex: options.useRegex,
			wholeWord: options.wholeWord,
			includeFiles: options.includeFiles || "",
			excludeFiles: options.excludeFiles || ""
		});

		if (!res.success) {
			throw new Error("An error occurred while searching for files.");
		}

		this.searching = true;
		this.onStart?.();

		this.relay.stream(res.requestId, (chunk: Buffer) => {
			let chunkString = chunk.toString("utf8");
			let searchResults: SearchChunk[] | null = null;

			try {
				if (searchResults = JSON.parse(chunkString)) {
					this.onResultStream?.(searchResults);
				}
			}
			catch (error) {
			}
		}, () => {
			this.searching = false;
			this.onEnd?.();
		});

		return res.requestId;
	}

	isSearching() {
		return this.searching;
	}

	start(callback: () => void) {
		this.onStart = callback;
	}

	resultStream(callback: (chunk: SearchChunk[]) => void) {
		this.onResultStream = callback;
	}

	end(callback: () => void) {
		this.onEnd = callback;
	}
}