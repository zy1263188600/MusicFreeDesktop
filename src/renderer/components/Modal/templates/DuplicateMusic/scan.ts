import PQueue from "p-queue";
import { buildTagKey, decodeFingerprint, fileBaseKey, groupByKey, groupBySimilarity } from "@shared/audio-fingerprint/common";
import { calculateFingerprint, getFileHash, getFileStats, probeDurations } from "@shared/audio-fingerprint/renderer";

export type ScanMode = "audio" | "exact" | "tag" | "filename";
export interface ScanItem { key: string; title: string; artist: string; album?: string; duration?: number; localPath: string; size?: number }
export interface DuplicateGroup { ids: string[]; items: ScanItem[]; saveBytes?: number }
export interface ScanStats { hit: number; computed: number; skipped: number }

const emptyStats = (): ScanStats => ({ hit: 0, computed: 0, skipped: 0 });

export async function runDuplicateScan(
    items: ScanItem[],
    mode: ScanMode,
    threshold: number,
    onProgress: (done: number, total: number) => void,
    shouldCancel: () => boolean,
): Promise<{ groups: DuplicateGroup[]; skipped: Array<{ path: string; message: string }>; stats: ScanStats }> {
    const result = await runDuplicateScanInner(items, mode, threshold, onProgress, shouldCancel);
    await attachFileMeta(result.groups);
    return result;
}

async function runDuplicateScanInner(
    items: ScanItem[],
    mode: ScanMode,
    threshold: number,
    onProgress: (done: number, total: number) => void,
    shouldCancel: () => boolean,
): Promise<{ groups: DuplicateGroup[]; skipped: Array<{ path: string; message: string }>; stats: ScanStats }> {
    const skipped: Array<{ path: string; message: string }> = [];
    if (mode === "tag") {
        const keys = items.map((it) => buildTagKey(it.title, it.artist, it.album ?? "", it.duration));
        return { groups: toGroups(items, groupByKey(keys)), skipped, stats: emptyStats() };
    }
    if (mode === "filename") {
        const keys = items.map((it) => fileBaseKey(it.localPath));
        return { groups: toGroups(items, groupByKey(keys)), skipped, stats: emptyStats() };
    }
    if (mode === "exact") {
        const queue = new PQueue({ concurrency: 4 });
        const hashes = new Array<string>(items.length).fill("");
        let done = 0;
        await Promise.all(items.map((it, i) => queue.add(async () => {
            if (shouldCancel()) return;
            const r = await getFileHash(it.localPath);
            if (r.status === "success") hashes[i] = r.hash;
            else skipped.push({ path: it.localPath, message: r.message });
            done += 1;
            onProgress(done, items.length);
        })));
        if (shouldCancel()) return { groups: [], skipped, stats: emptyStats() };
        const keyed = hashes.map((h, i) => (h ? `hash:${h}` : `uniq:${i}`));
        return { groups: toGroups(items, groupByKey(keyed)), skipped, stats: emptyStats() };
    }
    const stats = emptyStats();
    const queue = new PQueue({ concurrency: 4 });
    const decoded: Array<number[] | null> = new Array(items.length).fill(null);
    const durations = items.map((it) => it.duration ?? 0);
    let done = 0;
    await Promise.all(items.map((it, i) => queue.add(async () => {
        if (shouldCancel()) return;
        const r = await calculateFingerprint(it.localPath);
        if (r.status === "success") {
            if (r.cached) stats.hit += 1;
            else stats.computed += 1;
            decoded[i] = decodeFingerprint(r.fingerprint);
            if (!items[i].duration) durations[i] = r.duration;
            // 库里没时长就用 fpcalc 回填，供结果行展示
            if (items[i].duration === undefined) items[i] = { ...items[i], duration: r.duration };
        } else {
            stats.skipped += 1;
            skipped.push({ path: it.localPath, message: r.message });
        }
        done += 1;
        onProgress(done, items.length);
    })));
    if (shouldCancel()) return { groups: [], skipped, stats };
    const valid = items.map((it, i) => ({ index: i, fingerprint: decoded[i], duration: durations[i] }))
        .filter((x) => x.fingerprint !== null) as Array<{ index: number; fingerprint: number[]; duration: number }>;
    const idxGroups = groupBySimilarity(valid, threshold);
    return {
        groups: idxGroups.map((idxs) => ({
            ids: idxs.map((k) => items[k].key),
            items: idxs.map((k) => items[k]),
        })),
        skipped,
        stats,
    };
}

function toGroups(items: ScanItem[], m: Map<string, number[]>): DuplicateGroup[] {

    const out: DuplicateGroup[] = [];
    m.forEach((idxs) => {
        if (idxs.length > 1) {
            out.push({ ids: idxs.map((k) => items[k].key), items: idxs.map((k) => items[k]) });
        }
    });
    return out;
}

// 只给已分组的重复项批量补文件大小和缺失的时长（数量少，一次 IPC），供结果行展示
async function attachFileMeta(groups: DuplicateGroup[]): Promise<void> {
    const items = [...new Map(groups.flatMap((g) => g.items).map((it) => [it.localPath, it])).values()];
    if (!items.length) return;
    const missing = items.filter((it) => it.duration === undefined).map((it) => it.localPath);
    try {
        const [sizes, durations] = await Promise.all([
            getFileStats(items.map((it) => it.localPath)),
            missing.length ? probeDurations(missing) : ({} as Record<string, number>),
        ]);
        items.forEach((it) => {
            const size = sizes[it.localPath];
            if (typeof size === "number") it.size = size;
            if (it.duration === undefined) {
                const duration = durations[it.localPath];
                if (typeof duration === "number" && Number.isFinite(duration)) it.duration = duration;
            }
        });
    } catch {
        // 取不到只影响展示，不阻塞去重结果
    }
}
