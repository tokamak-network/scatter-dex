// Type augmentations for the File System Access API. The stock
// TypeScript DOM lib (5.x) declares the core handle interfaces but
// is missing the permission probe + directory picker that browsers
// ship today (Chrome 86+, Edge 86+, Opera 72+).
//
// Declared via `declare global` (rather than an ambient `.d.ts`) so
// apps consuming `@zkscatter/sdk/storage` automatically pick the
// augmentations up through the import graph. A bare `.d.ts` only
// applies to its host project's compilation, leaving consumer apps
// with the missing-method errors.
//
// Mirrored from `frontend/app/lib/zk/fs-api.d.ts`. When the
// frontend migrates to `@zkscatter/sdk/storage`, the augmentation
// there can drop and only this file remains.

declare global {
  interface FileSystemPermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    queryPermission(
      descriptor?: FileSystemPermissionDescriptor,
    ): Promise<PermissionState>;
    requestPermission(
      descriptor?: FileSystemPermissionDescriptor,
    ): Promise<PermissionState>;
  }

  interface FileSystemWritableFileStream extends WritableStream {
    abort(reason?: unknown): Promise<void>;
  }

  interface Window {
    showDirectoryPicker(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
}

// `declare global` only takes effect inside a module — the empty
// export keeps this file from being treated as a script.
export {};
