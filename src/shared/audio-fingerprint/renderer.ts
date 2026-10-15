type CalcOk = { status: "success"; fingerprint: number[]; duration: number; cached: boolean };
type CalcErr = { status: "error"; message: string };
type CalcRes = CalcOk | CalcErr;

const bridge = () => (window as any)["@shared/fingerprint"];

export async function checkFingerprintBinary(): Promise<{ ok: boolean; path: string; error?: string }> {
    return bridge().checkBinary();
}

export async function calculateFingerprint(filePath: string): Promise<CalcRes> {
    return bridge().calculateFingerprint(filePath);
}

export async function getFileHash(filePath: string): Promise<{ status: "success"; hash: string } | { status: "error"; message: string }> {
    return bridge().fileHash(filePath);
}

export async function getFileStats(filePaths: string[]): Promise<Record<string, number>> {
    return bridge().fileStats(filePaths);
}

export async function clearFingerprintCache(): Promise<{ ok: boolean }> {
    return bridge().clearCache();
}

export async function pruneFingerprintCache(keepPaths: string[]): Promise<{ removed: number }> {
    return bridge().pruneCache(keepPaths);
}

export async function probeDurations(filePaths: string[]): Promise<Record<string, number>> {
    return bridge().probeDurations(filePaths);
}

export async function getFingerprintCacheInfo(): Promise<{ path: string; sizeBytes: number; exists: boolean; count: number; marksSizeBytes: number }> {
    return bridge().cacheInfo();
}

export async function deleteLocalFiles(paths: string[]): Promise<{ deleted: string[]; failed: Array<{ path: string; message: string }> }> {
    return bridge().deleteLocalFiles(paths);
}
