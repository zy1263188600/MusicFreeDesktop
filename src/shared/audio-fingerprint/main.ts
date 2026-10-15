import { app, ipcMain } from "electron";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { rimraf } from "rimraf";
import AppConfig from "@shared/app-config/main";
import { parseFile as parseMusicFile } from "music-metadata";

type CacheEntry = { mtimeMs: number; size: number; fingerprint: number[]; duration: number };

function resolveFpcalcBinary(): string {
    const plat = process.platform === "win32" ? "win-x64" : process.platform === "darwin" ? "mac-arm64" : "linux-x64";
    const exe = process.platform === "win32" ? "fpcalc.exe" : "fpcalc";
    const devPath = path.join(app.getAppPath(), "resources", "bin", plat, exe);
    const prodPath = path.join(process.resourcesPath, "bin", plat, exe);
    try {
        fs.accessSync(prodPath, fs.constants.X_OK);
        return prodPath;
    } catch { /* fallthrough */ }
    return devPath;
}

function cacheDir(): string {
    return AppConfig.getConfig("localMusic.fingerprintCacheDir") || app.getPath("userData");
}

function cachePath(): string {
    return path.join(cacheDir(), "fingerprint-cache.json");
}

// 手动版本标记与指纹缓存同目录共存亡（弹窗里用同名常量读写同一文件）
const MARKS_FILENAME = "version-marks.json";

function marksPath(): string {
    return path.join(cacheDir(), MARKS_FILENAME);
}

async function readCacheFile(): Promise<Record<string, CacheEntry>> {
    try {
        return JSON.parse(await fsp.readFile(cachePath(), "utf-8"));
    } catch {
        return {};
    }
}

// 指纹缓存常驻内存：每次 calculate 只读写内存、零磁盘 IO；
// 落盘由唯一的防抖 writer 负责，写文件本身再经链串行化，撕裂与丢条目都不可能
let memCache: Record<string, CacheEntry> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// 自上次落盘后的写入计数：攒够一批就刷一次，杀进程/断电最多丢一批
// （每刷一次要同步 stringify 几 MB 的 JSON，会卡主线程几百毫秒，批次不能太小）
let pendingWrites = 0;
const FLUSH_EVERY_N_WRITES = 50;

async function getMemCache(): Promise<Record<string, CacheEntry>> {
    if (!memCache) memCache = await readCacheFile();
    return memCache;
}

// 缓存文件写串行化：同一时刻最多一个完整写，避免交叉写撕裂 JSON
let cacheWriteChain: Promise<unknown> = Promise.resolve();

function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = cacheWriteChain.then(task, task);
    cacheWriteChain = run.catch(() => undefined);
    return run;
}

async function flushCacheFile(): Promise<void> {
    await enqueueCacheWrite(async () => {
        const current = memCache;
        if (current) await fsp.writeFile(cachePath(), JSON.stringify(current), "utf-8");
    });
    pendingWrites = 0;
}

function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushCacheFile();
    }, 2000);
}

async function flushCacheNow(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    await flushCacheFile();
}

async function runFpcalc(filePath: string): Promise<{ fingerprint: number[]; duration: number }> {
    const bin = resolveFpcalcBinary();
    return new Promise((resolve, reject) => {
        // -json -raw：官方推荐的机器可读输出；-raw 让 fingerprint 为原始整数数组（pre-flight 裁决）
        const child = spawn(bin, ["-json", "-raw", filePath], { windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            child.kill(); reject(new Error("fpcalc 超时")); 
        }, 60000);
        child.stdout.on("data", (d) => {
            out += String(d); 
        });
        child.stderr.on("data", (d) => {
            err += String(d); 
        });
        child.on("error", (e) => {
            clearTimeout(timer); reject(e); 
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(err || `fpcalc 退出码 ${code}`)); return; 
            }
            try {
                const parsed = JSON.parse(out) as { fingerprint?: unknown; duration?: unknown };
                if (!Array.isArray(parsed.fingerprint) || typeof parsed.duration !== "number") {
                    reject(new Error("fpcalc 输出解析失败"));
                    return;
                }
                resolve({ fingerprint: (parsed.fingerprint as number[]).filter((n) => Number.isFinite(n)), duration: parsed.duration });
            } catch {
                reject(new Error("fpcalc 输出解析失败"));
            }
        });
    });
}

class FingerprintService {
    setup(): void {
        // 指纹缓存目录默认随 userData（download.path 同款初始化方式）
        if (!AppConfig.getConfig("localMusic.fingerprintCacheDir")) {
            AppConfig.setConfig({
                "localMusic.fingerprintCacheDir": app.getPath("userData"),
            });
        }
        // 退出前把内存缓存刷盘（崩溃丢的顶多 2 秒增量，下次重算自愈）
        app.on("before-quit", () => {
            try {
                if (flushTimer) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
                if (memCache) fs.writeFileSync(cachePath(), JSON.stringify(memCache), "utf-8");
            } catch {
                // 退出时刷不进去下次重算
            }
        });
        ipcMain.handle("@shared/fingerprint/check-binary", async () => {
            const p = resolveFpcalcBinary();
            try {
                await fsp.access(p, fs.constants.X_OK);
                return { ok: true, path: p };
            } catch {
                return { ok: false, path: p, error: `找不到 fpcalc: ${p}` };
            }
        });

        ipcMain.handle("@shared/fingerprint/calculate", async (_evt, filePath: string) => {
            try {
                const st = await fsp.stat(filePath);
                if (!st.isFile()) return { status: "error", message: "不是有效文件" };
                const cache = await getMemCache();
                const hit = cache[filePath];
                if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
                    return { status: "success", fingerprint: hit.fingerprint, duration: hit.duration, cached: true };
                }
                const r = await runFpcalc(filePath);
                cache[filePath] = { mtimeMs: st.mtimeMs, size: st.size, fingerprint: r.fingerprint, duration: r.duration };
                pendingWrites += 1;
                if (pendingWrites >= FLUSH_EVERY_N_WRITES) await flushCacheFile();
                else scheduleFlush();
                return { status: "success", fingerprint: r.fingerprint, duration: r.duration, cached: false };
            } catch (e: any) {
                return { status: "error", message: e?.message ?? "计算失败" };
            }
        });

        ipcMain.handle("@shared/fingerprint/file-hash", async (_evt, filePath: string) => {
            try {
                const hash = await new Promise<string>((resolve, reject) => {
                    const h = crypto.createHash("md5");
                    const s = fs.createReadStream(filePath);
                    s.on("data", (d) => h.update(d));
                    s.on("end", () => resolve(h.digest("hex")));
                    s.on("error", reject);
                });
                return { status: "success", hash };
            } catch (e: any) {
                return { status: "error", message: e?.message ?? "hash 失败" };
            }
        });

        ipcMain.handle("@shared/fingerprint/file-stats", async (_evt, filePaths: string[]) => {
            const sizes: Record<string, number> = {};
            for (const filePath of filePaths) {
                try {
                    const st = await fsp.stat(filePath);
                    if (st.isFile()) sizes[filePath] = st.size;
                } catch {
                    // 单个文件不可读时跳过，不中断整批
                }
            }
            return sizes;
        });

        ipcMain.handle("@shared/fingerprint/cache-info", async () => {
            // 先落盘再读，保证看到的是内存里的最新状态
            await flushCacheNow();
            const cacheFile = cachePath();
            try {
                const st = await fsp.stat(cacheFile);
                if (!st.isFile()) return { path: cacheFile, sizeBytes: 0, exists: false, count: 0, marksSizeBytes: 0 };
                const cache = await getMemCache();
                let marksSizeBytes = 0;
                try {
                    const marksStat = await fsp.stat(marksPath());
                    if (marksStat.isFile()) marksSizeBytes = marksStat.size;
                } catch {
                    // 无标记文件=0
                }
                return { path: cacheFile, sizeBytes: st.size, exists: true, count: Object.keys(cache).length, marksSizeBytes };
            } catch {
                return { path: cacheFile, sizeBytes: 0, exists: false, count: 0, marksSizeBytes: 0 };
            }
        });

        // 只给缺失时长的重复项补时长（逐个读头信息，跳过失败）
        ipcMain.handle("@shared/fingerprint/probe-durations", async (_evt, filePaths: string[]) => {
            const out: Record<string, number> = {};
            for (const filePath of filePaths) {
                try {
                    const metadata = await parseMusicFile(filePath, { duration: true, skipCovers: true });
                    const duration = metadata.format.duration;
                    if (typeof duration === "number" && Number.isFinite(duration)) out[filePath] = duration;
                } catch {
                    // 读不到跳过
                }
            }
            return out;
        });

        ipcMain.handle("@shared/fingerprint/prune-cache", async (_evt, keepPaths: string[]) => {
            // 空快照不删：库还没加载出来时 keep 为空，误删等于清空全库缓存
            if (!keepPaths.length) return { removed: 0 };
            try {
                const cache = await getMemCache();
                const keep = new Set(keepPaths);
                let removed = 0;
                for (const key of Object.keys(cache)) {
                    if (!keep.has(key)) {
                        delete cache[key];
                        removed += 1;
                    }
                }
                if (removed) await flushCacheNow();
                return { removed };
            } catch {
                return { removed: 0 };
            }
        });

        ipcMain.handle("@shared/fingerprint/clear-cache", async () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            memCache = {};
            return enqueueCacheWrite(async () => {
                try {
                    await fsp.unlink(cachePath());
                } catch {
                    // 缓存文件不存在也算成功
                }
                try {
                    await fsp.unlink(marksPath());
                } catch {
                    // 标记与缓存共存亡：清库顺手清掉
                }
                return { ok: true };
            });
        });

        ipcMain.handle("@shared/fingerprint/delete-files", async (_evt, paths: string[]) => {
            const deleted: string[] = [];
            const failed: Array<{ path: string; message: string }> = [];
            try {
                for (const p of paths) {
                    try {
                        const st = await fsp.stat(p).catch(() => null);
                        if (!st || !st.isFile()) {
                            failed.push({ path: p, message: "非有效文件，已跳过" });
                            continue;
                        }
                        await rimraf(p);
                        deleted.push(p);
                    } catch (e: any) {
                        failed.push({ path: p, message: e?.message ?? "删除失败" });
                    }
                }
                const cache = await getMemCache();
                let dirty = false;
                for (const p of deleted) {
                    if (cache[p]) {
                        delete cache[p]; dirty = true;
                    }
                }
                if (dirty) scheduleFlush();
            } catch (e: any) {
                const msg = e?.message ?? "删除失败";
                for (const p of paths) {
                    if (!deleted.includes(p) && !failed.some((f) => f.path === p)) {
                        failed.push({ path: p, message: msg });
                    }
                }
            }
            return { deleted, failed };
        });
    }
}

export default new FingerprintService();
