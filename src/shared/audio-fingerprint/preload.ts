import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("@shared/fingerprint", {
    checkBinary: () => ipcRenderer.invoke("@shared/fingerprint/check-binary"),
    calculateFingerprint: (filePath: string) => ipcRenderer.invoke("@shared/fingerprint/calculate", filePath),
    fileHash: (filePath: string) => ipcRenderer.invoke("@shared/fingerprint/file-hash", filePath),
    fileStats: (filePaths: string[]) => ipcRenderer.invoke("@shared/fingerprint/file-stats", filePaths),
    clearCache: () => ipcRenderer.invoke("@shared/fingerprint/clear-cache"),
    pruneCache: (keepPaths: string[]) => ipcRenderer.invoke("@shared/fingerprint/prune-cache", keepPaths),
    probeDurations: (filePaths: string[]) => ipcRenderer.invoke("@shared/fingerprint/probe-durations", filePaths),
    cacheInfo: () => ipcRenderer.invoke("@shared/fingerprint/cache-info"),
    deleteLocalFiles: (paths: string[]) => ipcRenderer.invoke("@shared/fingerprint/delete-files", paths),
});
