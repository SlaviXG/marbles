import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "../state/store";
import { LocalFolderSource } from "./localFolderSource";

export type FolderStatus = "unsupported" | "idle" | "loading" | "watching" | "error";

const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;

// Drives the browser LocalFolderSource: pick a folder, load it into the same
// vault store the SSE stream feeds, then poll-watch for changes. This is the
// consumer (PWA) path that needs no Node server running.
export function useLocalFolder() {
  const [status, setStatus] = useState<FolderStatus>(supported ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []); // stop watching on unmount

  const pick = useCallback(async () => {
    const { setSnapshot, upsert, remove, setConnected } = useVault.getState();
    let source: LocalFolderSource;
    try {
      source = await LocalFolderSource.pick();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // user dismissed picker
      setStatus("error");
      setError(String(e));
      return;
    }
    setStatus("loading");
    try {
      stopRef.current?.(); // drop any previous folder's watcher
      const notes = await source.loadAll();
      setSnapshot(notes);
      setConnected(true);
      stopRef.current = source.watch({ onUpsert: upsert, onRemove: remove });
      setError(null);
      setStatus("watching");
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, []);

  return { pick, status, error };
}
