import { RelayClient } from "../modules/relay";

export function useRelay() {
	if (!globalThis.gmodRemoteRelay) {
		globalThis.gmodRemoteRelay = new RelayClient();
	}

	return globalThis.gmodRemoteRelay;
}