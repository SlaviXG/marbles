import { useEffect } from "react";
import { useVault } from "../state/store";

// Opens the SSE stream once and pipes server events into the store.
export function useVaultStream() {
  useEffect(() => {
    const { setSnapshot, upsert, remove, setConnected } = useVault.getState();
    const es = new EventSource("/api/stream");

    es.addEventListener("snapshot", (e) => {
      setSnapshot(JSON.parse((e as MessageEvent).data).notes);
      setConnected(true);
    });
    es.addEventListener("update", (e) => {
      upsert(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("remove", (e) => {
      remove(JSON.parse((e as MessageEvent).data).id);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);
}
