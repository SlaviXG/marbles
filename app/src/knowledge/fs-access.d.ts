// Minimal ambient types for the File System Access API surface we use. Not all
// of it ships in TS's lib.dom yet (showDirectoryPicker, the async iterators), so
// we declare just the members the LocalFolderSource touches. Merges with the
// lib.dom definitions where they already exist.
interface FileSystemFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
}
