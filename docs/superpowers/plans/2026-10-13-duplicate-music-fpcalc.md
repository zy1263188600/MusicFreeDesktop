# 歌曲去重（fpcalc真音纹） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本地音乐页实现对标 Duplicate Cleaner 5 的多模式歌曲去重（音纹/完全相同/标签/文件名），支持进度扫描、分组预览、一键选择助手与安全删除。

**Architecture:** 主进程 spawn 各平台 fpcalc 二进制算真音纹并经 IPC 暴露，渲染层 DuplicateMusic 弹窗用 p-queue 并发调度全量本地库，纯函数做归一化/相似度/分组，删除走主进程 rimraf 并同步 Dexie store。

**Tech Stack:** Electron 25 / TypeScript / React / fpcalc(Chromaprint) / p-queue / Dexie / rimraf / i18next

## Global Constraints

- 不新增在线歌单去重、不做无确认自动删除。
- 删除必须二次确认（复用 Reconfirm 模式），提供“彻底删除文件”与“仅从音乐库移除”双选项。
- 全量扫描必须有进度条与取消，失败文件跳过不中断。
- 指纹必须缓存（mtime+size 失效），`tsc --noEmit` 与 `eslint ./src` 通过。
- 本仓库无 jest/vitest，所有验证用 `npx tsc --noEmit`、`npx eslint` 与 `npx ts-node --transpile-only` 脚本完成。

---

## File Structure

- 删除：`src/shared/calculates-fingerprints/main.ts`、`src/shared/calculates-fingerprints/preload.ts`、`src/shared/calculates-fingerprints/renderer.ts`（整个目录删掉， Arquivo 现有实现在主进程用 `window` 必崩）。
- 新建：`src/shared/audio-fingerprint/common.ts`（纯函数：归一化、指纹解码、Hamming 相似度、分组）。
- 新建：`src/shared/audio-fingerprint/main.ts`（导出 `FingerprintService.setup(): void`；二进制定位、spawn fpcalc、JSON 缓存、4 个 IPC）。
- 新建：`src/shared/audio-fingerprint/preload.ts`（expose `window["@shared/fingerprint"]`）。
- 新建：`src/shared/audio-fingerprint/renderer.ts`（typed 封装供 React 调用）。
- 新建：`resources/bin/win-x64/fpcalc.exe`、`resources/bin/mac-arm64/fpcalc`、`resources/bin/linux-x64/fpcalc`（手动下载的二进制，不进 git 大文件以外；若缺失则对应平台报错）。
- 修改：`forge.config.ts`（`extraResource` 加 `resources/bin`）。
- 修改：`src/main/index.ts`（import 并在 bootstrap 中 `FingerprintService.setup()`）。
- 修改：`src/preload/common-preload.ts`（加 `import "@shared/audio-fingerprint/preload"`）。
- 新建：`scripts/verify-fingerprint-common.ts`（纯函数验证脚本，可重复运行）。
- 重写：`src/renderer/components/Modal/templates/DuplicateMusic/index.tsx`（完整弹窗）。
- 新建：`src/renderer/components/Modal/templates/DuplicateMusic/scan.ts`（扫描编排：模式调度、p-queue、取消 token）。
- 修改：`src/renderer/components/Modal/templates/DuplicateMusic/index.scss`（进度条、分组、行样式）。
- 修改：`res/lang/zh-CN.json`、`res/lang/en-US.json`、`res/lang/zh-TW.json`（补 `local_music_page.duplicate_music.*` 文案）。

IPC 契约（全局唯一，后续任务必须原样使用）：
- `"@shared/fingerprint/check-binary"` → `{ ok: boolean; path: string; error?: string }`
- `"@shared/fingerprint/calculate"` `(filePath: string)` → `{ status: "success"; fingerprint: number[]; duration: number } | { status: "error"; message: string }`（fingerprint 为 `fpcalc -json -raw` 输出的原始整数数组；pre-flight 裁决 2026-10-13：不用默认压缩文本格式）
- `"@shared/fingerprint/file-hash"` `(filePath: string)` → `{ status: "success"; hash: string } | { status: "error"; message: string }`
- `"@shared/fingerprint/delete-files"` `(paths: string[])` → `{ deleted: string[]; failed: Array<{ path: string; message: string }> }`

渲染层封装签名（`renderer.ts` 必须导出这三个）：
- `checkFingerprintBinary(): Promise<{ ok: boolean; path: string; error?: string }>`
- `calculateFingerprint(filePath: string): Promise<{ status: "success"; fingerprint: string; duration: number } | { status: "error"; message: string }>`
- `deleteLocalFiles(paths: string[]): Promise<{ deleted: string[]; failed: Array<{ path: string; message: string }> }>`

---

### Task 1: fpcalc 二进制落位 + 打包配置

**Files:**
- Create: `resources/bin/win-x64/fpcalc.exe`, `resources/bin/mac-arm64/fpcalc`, `resources/bin/linux-x64/fpcalc`（手动下载）
- Modify: `forge.config.ts:12-17`

**Interfaces:**
- Consumes: 无（首任务）
- Produces: `resources/bin/<platform>/fpcalc*` 存在；`packagerConfig.extraResource` 包含 bin 目录；Task 3 的 `resolveFpcalcBinary()` 按此约定寻址。

- [ ] **Step 1: 下载 fpcalc 二进制并落位**

从 https://acoustid.org/chromaprint 下载对应平台包，解压后落位为：
```text
resources/bin/win-x64/fpcalc.exe
resources/bin/mac-arm64/fpcalc
resources/bin/linux-x64/fpcalc
```
mac/linux 落位后执行 `chmod +x`。二进制不提交到 git（保持 untracked，本地与打包机各自放置）。

- [ ] **Step 2: 修改 forge.config.ts 的 extraResource**

```ts
extraResource: [
  path.resolve(__dirname, "res"),
  path.resolve(__dirname, "resources/bin"),
],
```

- [ ] **Step 3: 验证打包配置与类型**

Run: `npx tsc --noEmit`
Expected: PASS（无新增类型错误）

- [ ] **Step 4: Commit**

```bash
git add forge.config.ts
git commit -m "chore: 打包携带fpcalc二进制目录"
```

---

### Task 2: 纯函数 common.ts（归一化/相似度/分组）

**Files:**
- Create: `src/shared/audio-fingerprint/common.ts`
- Create: `scripts/verify-fingerprint-common.ts`

**Interfaces:**
- Consumes: 无
- Produces: `normalizeTag(s: string): string`；`buildTagKey(title: string, artist: string, album: string, duration: number | undefined): string`；`fileBaseKey(filePath: string): string`；`decodeFingerprint(fp: number[] | string): number[]`；`hammingSimilarity(a: number[], b: number[]): number`；`groupByKey(keys: string[]): Map<string, number[]>`；`groupBySimilarity(items: Array<{ index: number; fingerprint: number[]; duration: number }>, threshold: number): number[][]`。Task 5 的 `scan.ts` 原样 import 这些函数。

- [ ] **Step 1: 写 common.ts 最小实现**

```ts
export function normalizeTag(s: string): string {
    return (s ?? "")
        .toLowerCase()
        .replace(/[\s\-_、。．，．·•‐‑‒–—―…,.!?！？；;：:"'“”‘’（）()【】\[\]{}<>《》・、]/g, "")
        .replace(/　/g, "")
        .trim();
}

export function buildTagKey(title: string, artist: string, album: string, duration: number | undefined): string {
    const bucket = duration === undefined ? "nodur" : String(Math.round(duration / 2));
    return [normalizeTag(title), normalizeTag(artist), normalizeTag(album), bucket].join("|");
}

export function fileBaseKey(filePath: string): string {
    const base = filePath.split(/[/\\]/).pop() ?? filePath;
    const noExt = base.replace(/\.[a-z0-9]{2,5}$/i, "");
    return normalizeTag(noExt);
}

export function decodeFingerprint(fp: number[] | string): number[] {
    if (Array.isArray(fp)) {
        return fp.filter((n) => Number.isFinite(n));
    }
    const out: number[] = [];
    const parts = fp.split(",");
    for (const p of parts) {
        const n = Number(p);
        if (Number.isFinite(n)) out.push(n);
    }
    return out;
}

export function hammingSimilarity(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let same = 0;
    for (let i = 0; i < n; i++) {
        let x = (a[i] ^ b[i]) >>> 0;
        let bits = 0;
        while (x) { bits += x & 1; x >>>= 1; }
        same += 32 - bits;
    }
    return same / (n * 32);
}

export function groupByKey(keys: string[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    keys.forEach((k, i) => {
        const arr = m.get(k);
        if (arr) arr.push(i);
        else m.set(k, [i]);
    });
    return m;
}

export function groupBySimilarity(
    items: Array<{ index: number; fingerprint: number[]; duration: number }>,
    threshold: number,
): number[][] {
    const groups: number[][] = [];
    const used = new Set<number>();
    for (let i = 0; i < items.length; i++) {
        if (used.has(items[i].index)) continue;
        const g = [items[i].index];
        used.add(items[i].index);
        for (let j = i + 1; j < items.length; j++) {
            if (used.has(items[j].index)) continue;
            if (Math.abs(items[i].duration - items[j].duration) > 15) continue;
            const sim = hammingSimilarity(items[i].fingerprint, items[j].fingerprint);
            if (sim >= threshold) {
                g.push(items[j].index);
                used.add(items[j].index);
            }
        }
        if (g.length > 1) groups.push(g);
    }
    return groups;
}
```

- [ ] **Step 2: 写验证脚本**

```ts
// scripts/verify-fingerprint-common.ts
import { normalizeTag, buildTagKey, hammingSimilarity, groupByKey, decodeFingerprint } from "../src/shared/audio-fingerprint/common";
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
assert(normalizeTag("  Hello-World！ ") === "helloworld", "normalize");
assert(buildTagKey("夜曲", "周杰伦", "十一月的萧邦", 211) === buildTagKey("夜曲", "周杰伦", "十一月的萧邦", 212), "tag bucket");
assert(decodeFingerprint("1,2,3").length === 3, "decode string");
assert(decodeFingerprint([5, 6, 7]).join(",") === "5,6,7", "decode array passthrough");
assert(hammingSimilarity([1, 2], [1, 2]) === 1, "similarity identical");
const m = groupByKey(["a", "b", "a"]);
assert((m.get("a") ?? []).length === 2, "groupByKey");
console.log("verify-fingerprint-common PASS");
```

- [ ] **Step 3: 运行验证**

Run: `npx ts-node --transpile-only scripts/verify-fingerprint-common.ts`
Expected: 输出 `verify-fingerprint-common PASS`

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/audio-fingerprint/common.ts scripts/verify-fingerprint-common.ts
git commit -m "feat: 音纹去重纯函数与分组算法"
```

---

### Task 3: 主进程 FingerprintService（spawn+缓存+IPC）

**Files:**
- Create: `src/shared/audio-fingerprint/main.ts`
- Modify: `src/main/index.ts:12-23,167-169`
- Delete: `src/shared/calculates-fingerprints/` 整个目录

**Interfaces:**
- Consumes: Task 1 的二进制路径约定；Task 2 仅约定类型（本任务不 import common.ts，保持主进程零依赖）。
- Produces: 默认导出 `FingerprintService` 具 `setup(): void`；4 个 IPC 通道（见文件头契约）；缓存文件 `<userData>/fingerprint-cache.json`，条目 `{ mtimeMs: number; size: number; fingerprint: number[]; duration: number }`。Task 4 按此通道名调用。

- [ ] **Step 1: 写 main.ts**

```ts
import { app, ipcMain } from "electron";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { rimraf } from "rimraf";

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

function cachePath(): string {
    return path.join(app.getPath("userData"), "fingerprint-cache.json");
}

async function readCache(): Promise<Record<string, CacheEntry>> {
    try {
        return JSON.parse(await fsp.readFile(cachePath(), "utf-8"));
    } catch {
        return {};
    }
}

async function runFpcalc(filePath: string): Promise<{ fingerprint: number[]; duration: number }> {
    const bin = resolveFpcalcBinary();
    return new Promise((resolve, reject) => {
        // -json -raw：官方推荐的机器可读输出；-raw 让 fingerprint 为原始整数数组（pre-flight 裁决）
        const child = spawn(bin, ["-json", "-raw", filePath], { windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("fpcalc 超时")); }, 60000);
        child.stdout.on("data", (d) => { out += String(d); });
        child.stderr.on("data", (d) => { err += String(d); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) { reject(new Error(err || `fpcalc 退出码 ${code}`)); return; }
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
                const cache = await readCache();
                const hit = cache[filePath];
                if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
                    return { status: "success", fingerprint: hit.fingerprint, duration: hit.duration };
                }
                const r = await runFpcalc(filePath);
                cache[filePath] = { mtimeMs: st.mtimeMs, size: st.size, fingerprint: r.fingerprint, duration: r.duration };
                await fsp.writeFile(cachePath(), JSON.stringify(cache), "utf-8");
                return { status: "success", fingerprint: r.fingerprint, duration: r.duration };
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

        ipcMain.handle("@shared/fingerprint/delete-files", async (_evt, paths: string[]) => {
            const deleted: string[] = [];
            const failed: Array<{ path: string; message: string }> = [];
            for (const p of paths) {
                try {
                    await rimraf(p);
                    deleted.push(p);
                } catch (e: any) {
                    failed.push({ path: p, message: e?.message ?? "删除失败" });
                }
            }
            const cache = await readCache();
            let dirty = false;
            for (const p of deleted) {
                if (cache[p]) { delete cache[p]; dirty = true; }
            }
            if (dirty) await fsp.writeFile(cachePath(), JSON.stringify(cache), "utf-8");
            return { deleted, failed };
        });
    }
}

export default new FingerprintService();
```

- [ ] **Step 2: 注册到 src/main/index.ts**

```ts
import FingerprintService from "@shared/audio-fingerprint/main";
```

在 `bootstrap()` 内 `ServiceManager.setup(windowManager);` 下一行加：

```ts
FingerprintService.setup();
```

- [ ] **Step 3: 删除旧目录**

```bash
git rm -r src/shared/calculates-fingerprints
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/audio-fingerprint/main.ts src/main/index.ts
git commit -m "feat: 主进程指纹服务与fpcalc调用"
```

---

### Task 4: preload + renderer 封装与注册

**Files:**
- Create: `src/shared/audio-fingerprint/preload.ts`
- Create: `src/shared/audio-fingerprint/renderer.ts`
- Modify: `src/preload/common-preload.ts:5-10`

**Interfaces:**
- Consumes: Task 3 的 4 个 IPC 通道名。
- Produces: `window["@shared/fingerprint"]` 具 `checkBinary/calculateFingerprint/fileHash/deleteLocalFiles`；`renderer.ts` 导出 `checkFingerprintBinary/calculateFingerprint/getFileHash/deleteLocalFiles` 四函数。Task 5 的 `scan.ts` 只从 `renderer.ts` import。

- [ ] **Step 1: 写 preload.ts**

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("@shared/fingerprint", {
    checkBinary: () => ipcRenderer.invoke("@shared/fingerprint/check-binary"),
    calculateFingerprint: (filePath: string) => ipcRenderer.invoke("@shared/fingerprint/calculate", filePath),
    fileHash: (filePath: string) => ipcRenderer.invoke("@shared/fingerprint/file-hash", filePath),
    deleteLocalFiles: (paths: string[]) => ipcRenderer.invoke("@shared/fingerprint/delete-files", paths),
});
```

- [ ] **Step 2: 写 renderer.ts**

```ts
type CalcOk = { status: "success"; fingerprint: number[]; duration: number };
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

export async function deleteLocalFiles(paths: string[]): Promise<{ deleted: string[]; failed: Array<{ path: string; message: string }> }> {
    return bridge().deleteLocalFiles(paths);
}
```

- [ ] **Step 3: 注册到 common-preload.ts**

```ts
import "@shared/audio-fingerprint/preload";
```

加在 `import "@shared/window-drag/preload";` 下一行。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。渲染层此前的 `window['@shared/fingerprint']` any 调用不再报错。

- [ ] **Step 5: Commit**

```bash
git add src/shared/audio-fingerprint/preload.ts src/shared/audio-fingerprint/renderer.ts src/preload/common-preload.ts
git commit -m "feat: 指纹preload桥接与渲染层封装"
```

---

### Task 5: 扫描编排 scan.ts（模式调度+并发+取消）

**Files:**
- Create: `src/renderer/components/Modal/templates/DuplicateMusic/scan.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildTagKey/fileBaseKey/decodeFingerprint/hammingSimilarity/groupByKey/groupBySimilarity`；Task 4 的 `calculateFingerprint/getFileHash`；`localMusicListStore` 条目 `{ id, platform, title, artist, album, duration?, $$localPath }`。
- Produces: `export type ScanMode = "audio" | "exact" | "tag" | "filename"`；`export interface ScanItem { key: string; title: string; artist: string; album?: string; duration?: number; localPath: string; size?: number }`；`export interface DuplicateGroup { ids: string[]; items: ScanItem[]; saveBytes?: number }`；`export async function runDuplicateScan(items: ScanItem[], mode: ScanMode, threshold: number, onProgress: (done: number, total: number) => void, shouldCancel: () => boolean): Promise<{ groups: DuplicateGroup[]; skipped: Array<{ path: string; message: string }> }>`。Task 6 的弹窗只调这一个函数。

- [ ] **Step 1: 写 scan.ts**

```ts
import PQueue from "p-queue";
import { buildTagKey, decodeFingerprint, fileBaseKey, groupByKey, groupBySimilarity } from "@shared/audio-fingerprint/common";
import { calculateFingerprint, getFileHash } from "@shared/audio-fingerprint/renderer";

export type ScanMode = "audio" | "exact" | "tag" | "filename";
export interface ScanItem { key: string; title: string; artist: string; album?: string; duration?: number; localPath: string; size?: number }
export interface DuplicateGroup { ids: string[]; items: ScanItem[]; saveBytes?: number }

export async function runDuplicateScan(
    items: ScanItem[],
    mode: ScanMode,
    threshold: number,
    onProgress: (done: number, total: number) => void,
    shouldCancel: () => boolean,
): Promise<{ groups: DuplicateGroup[]; skipped: Array<{ path: string; message: string }> }> {
    const skipped: Array<{ path: string; message: string }> = [];
    if (mode === "tag") {
        const keys = items.map((it) => buildTagKey(it.title, it.artist, it.album ?? "", it.duration));
        return { groups: toGroups(items, groupByKey(keys)), skipped };
    }
    if (mode === "filename") {
        const keys = items.map((it) => fileBaseKey(it.localPath));
        return { groups: toGroups(items, groupByKey(keys)), skipped };
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
        if (shouldCancel()) return { groups: [], skipped };
        const keyed = hashes.map((h, i) => (h ? `hash:${h}` : `uniq:${i}`));
        return { groups: toGroups(items, groupByKey(keyed)), skipped };
    }
    const queue = new PQueue({ concurrency: 4 });
    const decoded: Array<number[] | null> = new Array(items.length).fill(null);
    const durations = items.map((it) => it.duration ?? 0);
    let done = 0;
    await Promise.all(items.map((it, i) => queue.add(async () => {
        if (shouldCancel()) return;
        const r = await calculateFingerprint(it.localPath);
        if (r.status === "success") {
            decoded[i] = decodeFingerprint(r.fingerprint);
            if (!items[i].duration) durations[i] = r.duration;
        } else {
            skipped.push({ path: it.localPath, message: r.message });
        }
        done += 1;
        onProgress(done, items.length);
    })));
    if (shouldCancel()) return { groups: [], skipped };
    const valid = items.map((it, i) => ({ index: i, fingerprint: decoded[i], duration: durations[i] }))
        .filter((x) => x.fingerprint !== null) as Array<{ index: number; fingerprint: number[]; duration: number }>;
    const idxGroups = groupBySimilarity(valid, threshold);
    return {
        groups: idxGroups.map((idxs) => ({
            ids: idxs.map((k) => items[k].key),
            items: idxs.map((k) => items[k]),
        })),
        skipped,
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
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Modal/templates/DuplicateMusic/scan.ts
git commit -m "feat: 去重扫描编排与并发调度"
```

---

### Task 6: DuplicateMusic 弹窗 UI（模式/进度/分组/选择助手）

**Files:**
- Modify: `src/renderer/components/Modal/templates/DuplicateMusic/index.tsx`（全量重写，组件名改为 `DuplicateMusic`）
- Modify: `src/renderer/components/Modal/templates/DuplicateMusic/index.scss`（加进度条、分组、行样式）

**Interfaces:**
- Consumes: Task 5 的 `runDuplicateScan/ScanMode/DuplicateGroup`；`localMusicListStore`；`trackPlayer.playMusicWithReplaceQueue`；`shellUtil.showItemInFolder(path)`（`@shared/utils/renderer` 导出 `shell: shellUtil`，返回 Promise<boolean>；注意不是 `dialogUtil.shell`——Task 6 实施时已纠正）；`hideModal/showModal(Reconfirm)`。
- Produces: 用户可见弹窗；选中集合 `Set<string>`（key=`platform+id`）；Task 7 调用删除时消费该集合。

- [ ] **Step 1: 重写 index.tsx**

```tsx
import { useRef, useState } from "react";
import Base from "../Base";
import "./index.scss";
import { useTranslation } from "react-i18next";
import localMusicListStore from "@/renderer/core/local-music/store";
import trackPlayer from "@/renderer/core/track-player";
import { shellUtil } from "@shared/utils/renderer";
import { checkFingerprintBinary } from "@shared/audio-fingerprint/renderer";
import { runDuplicateScan, ScanMode, DuplicateGroup } from "./scan";
import { hideModal } from "../..";

const THRESHOLDS = { strict: 0.95, standard: 0.88, loose: 0.8 } as const;

export default function DuplicateMusic() {
    const { t } = useTranslation();
    const [mode, setMode] = useState<ScanMode>("audio");
    const [level, setLevel] = useState<keyof typeof THRESHOLDS>("standard");
    const [scanning, setScanning] = useState(false);
    const [done, setDone] = useState(0);
    const [total, setTotal] = useState(0);
    const [binError, setBinError] = useState<string | null>(null);
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const cancelRef = useRef(false);

    const startScan = async () => {
        setBinError(null);
        if (mode === "audio") {
            const bin = await checkFingerprintBinary();
            if (!bin.ok) {
                setBinError(bin.error ?? "fpcalc missing");
                return;
            }
        }
        cancelRef.current = false;
        setScanning(true);
        setGroups([]);
        const list = localMusicListStore.getValue();
        setTotal(list.length);
        setDone(0);
        const { groups: g } = await runDuplicateScan(
            list.map((it) => ({ key: `${it.platform}+${it.id}`, title: it.title, artist: it.artist, album: it.album, duration: it.duration, localPath: it.$$localPath })),
            mode,
            THRESHOLDS[level],
            (d, tt) => { setDone(d); setTotal(tt); },
            () => cancelRef.current,
        );
        if (!cancelRef.current) setGroups(g);
        setScanning(false);
    };

    return (
        <Base defaultClose>
            <div className="modal--duplicate-music-container shadow backdrop-color">
                <Base.Header>{t("local_music_page.duplicate_music")}</Base.Header>
                <div className="mode-tabs">
                    {(["audio", "exact", "tag", "filename"] as ScanMode[]).map((m) => (
                        <div key={m} role="button" className="tab" data-active={mode === m} onClick={() => setMode(m)}>{m}</div>
                    ))}
                </div>
                <div role="button" data-type="primaryButton" onClick={startScan}>{t("common.confirm")}</div>
                {binError && <div className="error">{binError}</div>}
                {scanning && <div className="progress">{done}/{total}</div>}
                <div className="groups">
                    {groups.map((g, gi) => (
                        <div key={gi} className="group">
                            {g.items.map((it) => (
                                <div key={it.key} className="row">
                                    <span>{it.title} - {it.artist}</span>
                                    <span
                                        role="button"
                                        onClick={() => {
                                            const full = localMusicListStore.getValue().find((x) => `${x.platform}+${x.id}` === it.key);
                                            if (full) trackPlayer.playMusicWithReplaceQueue([full], full);
                                        }}
                                    >试听</span>
                                    <span role="button" onClick={() => shellUtil.showItemInFolder(it.localPath)}>定位</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
                <div
                    role="button"
                    data-type="normalButton"
                    onClick={() => {
                        cancelRef.current = true;
                        hideModal();
                    }}
                >{t("common.cancel")}</div>
            </div>
        </Base>
    );
}
```

- [ ] **Step 2: 补 scss（进度/分组/行）**

```scss
.modal--duplicate-music-container {
  width: 90%;
  height: 90%;
  border-radius: 8px;
  display: flex;
  flex-direction: column;

  .mode-tabs {
    display: flex;
    gap: 8px;
    .tab {
      padding: 8px 16px;
      cursor: pointer;
      &[data-active="true"] {
        color: var(--primaryColor);
        font-weight: bold;
      }
    }
  }

  .progress {
    padding: 8px 16px;
  }

  .error {
    padding: 8px 16px;
    color: var(--dangerColor, #fc5f5f);
  }

  .groups {
    flex: 1;
    overflow: auto;
    .group {
      border-top: 1px solid var(--dividerColor);
      padding: 8px 0;
      .row {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 4px 16px;
      }
    }
  }
}
```

- [ ] **Step 3: 启动 dev 验证弹窗可开**

Run: `npm run dev` 后打开本地音乐页点击“歌曲去重”，切换 4 个 Tab，点击扫描（无 fpcalc 时应弹 Reconfirm 提示）。
Expected: 弹窗正常开合；audio 模式缺二进制时有提示而非白屏。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Modal/templates/DuplicateMusic/index.tsx src/renderer/components/Modal/templates/DuplicateMusic/index.scss
git commit -m "feat: 去重弹窗扫描与分组展示"
```

---

### Task 7: 删除链路 + i18n + 样本验收

**Files:**
- Modify: `src/renderer/components/Modal/templates/DuplicateMusic/index.tsx`（在 Task 6 基础上加选择助手与删除按钮）
- Modify: `res/lang/zh-CN.json`, `res/lang/en-US.json`, `res/lang/zh-TW.json`
- Modify: `src/renderer/components/Modal/templates/index.ts`（保持 DuplicateMusic 注册，修正模板 props 类型若报错）

**Interfaces:**
- Consumes: Task 4 的 `deleteLocalFiles`；`musicSheetDB.localMusicStore.bulkDelete`；`localMusicListStore.setValue/getValue`。
- Produces: 删除后三者一致（磁盘/DB/store）；无遗留 TODO。

- [ ] **Step 1: 在弹窗加选择助手与删除（删除必须经 Reconfirm 二次确认，模式见 `plugin-table/index.tsx`）**

在 Task 6 的 `DuplicateMusic` 组件内 `groups` 渲染区上方加（需在文件头补 `import { showModal, hideModal } from "../..";`，`hideModal` 此前仅取消按钮用，保留）：

```tsx
<div className="assist">
    <span
        role="button"
        onClick={() => {
            const keep = new Set(groups.map((g) => g.ids[0]));
            const next = new Set<string>();
            groups.forEach((g) => g.ids.forEach((id) => { if (!keep.has(id)) next.add(id); }));
            setChecked(next);
        }}
    >每组保留第一首</span>
    <span
        role="button"
        onClick={() => {
            const targets = groups.flatMap((g) => g.items).filter((it) => checked.has(it.key));
            if (!targets.length) return;
            showModal("Reconfirm", {
                title: t("local_music_page.duplicate_music"),
                content: `确定彻底删除 ${targets.length} 个文件吗？磁盘文件将被删除且不可恢复。`,
                async onConfirm() {
                    hideModal();
                    const { deleteLocalFiles } = await import("@shared/audio-fingerprint/renderer");
                    const r = await deleteLocalFiles(targets.map((it) => it.localPath));
                    if (r.failed.length) console.error(r.failed);
                    const okPaths = new Set(r.deleted);
                    const okKeys = new Set(targets.filter((it) => okPaths.has(it.localPath)).map((it) => it.key));
                    const { default: musicSheetDB } = await import("@renderer/core/db/music-sheet-db");
                    const full = localMusicListStore.getValue().filter((x) => okKeys.has(`${x.platform}+${x.id}`));
                    await musicSheetDB.localMusicStore.bulkDelete(full.map((x) => [x.platform, x.id]) as any);
                    localMusicListStore.setValue(localMusicListStore.getValue().filter((x) => !okKeys.has(`${x.platform}+${x.id}`)));
                    setChecked(new Set());
                },
            });
        }}
    >彻底删除选中文件</span>
    <span
        role="button"
        onClick={() => {
            const targets = groups.flatMap((g) => g.items).filter((it) => checked.has(it.key));
            if (!targets.length) return;
            showModal("Reconfirm", {
                title: t("local_music_page.duplicate_music"),
                content: `确定将 ${targets.length} 首从音乐库移除吗？磁盘文件将保留。`,
                async onConfirm() {
                    hideModal();
                    const keys = new Set(targets.map((it) => it.key));
                    const { default: musicSheetDB } = await import("@renderer/core/db/music-sheet-db");
                    const full = localMusicListStore.getValue().filter((x) => keys.has(`${x.platform}+${x.id}`));
                    await musicSheetDB.localMusicStore.bulkDelete(full.map((x) => [x.platform, x.id]) as any);
                    localMusicListStore.setValue(localMusicListStore.getValue().filter((x) => !keys.has(`${x.platform}+${x.id}`)));
                    setChecked(new Set());
                },
            });
        }}
    >仅从音乐库移除</span>
</div>
```

注意：key 一律用 `${platform}+${id}` 构造、比较，禁止 `split("+")` 反解（id 本身可能含 `+`）；删 DB 时用查到的整条目取 `[platform, id]` 元组，与 `local-music/index.ts` 的 `bulkDelete` 用法一致。

- [ ] **Step 2: 补三语探测文案**

`zh-CN.json` 的 `local_music_page` 下确保有：

```json
"duplicate_music": "歌曲去重"
```

`en-US.json` / `zh-TW.json` 同步加对应英文/繁体。缺失时 `t()` 回退 key，直接肉眼可发现。

- [ ] **Step 3: 样本验收**

准备 3 组本地文件：A 同文件复制两份；B 同一首歌 mp3-128k + flac；C 不同歌但同标题。
分别跑 exact（应只命中 A）、audio 标准档（应命中 A+B，不命中 C）、tag（按标签预期命中）。
删除 1 个选中文件后断言磁盘文件消失、`localMusicStore.toArray()` 长度减 1、store 值一致。

- [ ] **Step 4: 全量检查**

Run: `npx tsc --noEmit`
Run: `npx eslint ./src --no-warn`
Expected: 两条都 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Modal/templates/DuplicateMusic/index.tsx res/lang/zh-CN.json res/lang/en-US.json res/lang/zh-TW.json
git commit -m "feat: 去重选择助手删除链路与多语言"
```

