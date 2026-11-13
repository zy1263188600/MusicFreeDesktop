---
name: musicfree-dedup-similarity
description: MusicFreeDesktop 本地音乐去重与相似歌曲功能的长期上下文、调研结论和实施方案。当任务涉及去重弹窗（DuplicateMusicModal）、相似歌曲检测、音频指纹（audioFingerprint/fpcalc）、播放缓存、下载相似提示、播放队列相似标识、本地库比对时，必须使用本 skill，先读再动手，避免重复调研和破坏既有约定。触发词：去重、相似、相似度、重复歌曲、播放缓存、下载提示、队列标识、DuplicateMusicModal、audioFingerprint、fpcalc、hamming、本地音乐。
---

# MusicFreeDesktop 去重 / 相似歌曲功能记忆库

本 skill 记录两件事：

1. 已完成并验证过的去重进度 UI 改动（改动尚未提交，见「当前工作区状态」）。
2. 下一步要大改的「被动相似检测」需求的完整调研与设计方案。

**使用方式**：涉及上述任何主题时，先通读本文件，再决定改哪里。不要重新做一遍播放链路、下载链路、指纹接口的调研——结论都在下面。实施前先和用户确认「待确认决策」里的 4 个点。

## 仓库与工作区状态

- 仓库：`C:\code\MusicFreeDesktop`
- 最近提交：`4c54149 feat(local-music): progress mode labels, unseen tabs, exact renamed`
- 当前未提交改动：
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/index.tsx`
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/index.scss`
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/store.ts`
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/scan.ts`
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/MiniPlayer.tsx`
  - `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/usePreviewPlayer.ts`
  - `src/infra/musicSheet/main/index.ts`
  - `src/main/core/builtinPlugins/localPlugin.ts`
- 这些文件是「去重弹窗进度区位置统一」「音纹按钮合并」「删除就地确认」「对比渐进出结果」「试听迷你播放条」「本地歌曲完整数据回退」的改动，已完成 eslint / prettier / tsc 验证，**不要回退**。

---

## 一、已完成：去重弹窗进度区统一

### 问题

切换去重弹窗的四个模式标签（音纹 / hash / 标签 / 文件名）时，进度条一会儿在操作按钮上方、一会儿在下方。

根因有两层：

1. 当前 tab 的进度（`mainProg`）渲染在按钮行下方，其他 tab 的后台任务（`__bg-task`）却渲染在按钮行之前，而音纹行与非音纹行的按钮行渲染顺序不同，导致相对位置翻转。
2. 音纹操作行元素多、会换行，其他模式只有一行，即使顺序统一，进度条的绝对 Y 坐标仍会跳。
3. 附带 bug：音纹 tab 计算指纹时，同一个任务会同时以「主进度条」和「后台任务条」渲染两次。

### 改法

- 删除 `mainProg` 单独块与 `__bg-task` / `__bg-bar` 两套样式。
- 新增统一的 `runningTasks`（`scanState.scanning` 全量），渲染在**模式 TabBar 正下方、操作行上方**的 `__tasks` 容器里，位置完全不随 tab 切换变化。
- 每行结构统一：模式名 + 阶段 + `done/total` + 6px 进度条 + 取消按钮；行高 `min-height: 28px`，多任务间 `gap: var(--space-1-5)`。
- 当前 tab 对应的任务 key 为高亮项（`mainProgKey`），其余任务加 `is-background`（`opacity: 0.6`），只淡化、不改行高。
- 任务按**启动先后**排序（`startedAt` 升序，最早启动的在最上面、最新启动的追加在最下面），音纹任务不再固定排第一；同一任务刷新进度时保留首次 `startedAt`，不会因进度更新换位。`startedAt` 由 `store.ts` 的 `setScanProgress` 自动维护，调用方无需传。
- 音纹的 `__footnote` 移到进度区之后；error 保持在进度区之后。

### 关键代码现状

- 派生状态在 `DuplicateMusicModal/index.tsx`：
  ```ts
  const audioRun = findAudioRun();
  const mainProgKey = mode === 'audio' ? audioRun?.key : currentKey;
  const runningTasks = Object.entries(scanState.scanning).sort(
      ([, a], [, b]) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  ```
- `FingerprintScanProgress` 含 `startedAt`；`setScanProgress(key, prog)` 的入参类型为 `Omit<FingerprintScanProgress, 'startedAt'> | null`，内部首次写入时补 `Date.now()`，后续更新沿用旧值。
- 渲染顺序：`toolbar` → `__tasks` → `action-row` / `audio-row` → `footnote` → `error` → `assist` → `results`。
- 样式在 `index.scss` 的 `&__tasks` / `&__progress` / `&.is-background`。

### 验收

- 四个模式标签来回切，进度区位置不动；只有高亮/淡化变化。
- 同时跑多个模式时，进度行统一按启动先后排列：先启动的在上，最新启动的在最下面（音纹不特殊）。
- 音纹计算任务只出现一行。
- `npx prettier --check`、`npx eslint`、`npx tsc --noEmit -p tsconfig.json` 全部通过。

### 追加改动（2026-11-13）

- **音纹按钮合并**：移除独立的「对比/重新对比」按钮；音纹 tab 主按钮统一为「计算」（`duplicate_compute`，文案已从「计算音纹」改为「计算」），点击执行 `compute-new` 后自动对比，结果直接写入 `groupsByKey[currentKey]`。`compute-all`（重算所有音纹）同样算完自动对比。清空指纹缓存按钮保留。
- 音纹任务 key 统一为 `currentKey`（`audio|阈值`），不再使用 `audio-compute`，进度行与结果 key 一致。
- **文案**：`duplicate_mark_version` 改为「标记为不同版本」（zh-TW：標記為不同版本；en-US：Mark as different version）。
- **删除改为列表内两步确认**：点击「删除选中文件」不再弹 `ConfirmModal`，改为把助手行替换为 `__delete-confirm` 内联确认条（`role="alert"`），选中行加 `is-pending-delete`（浅红底 + 左侧红条）。确认后原地更新当前 `groupsByKey`，只移除已删除项，不重建整个列表；分组 key 用 `g.ids.join('|')` 保持稳定，滚动位置不跳。
- 确认条出现时改动勾选会自动退出确认态；切换 tab、清空缓存、重算全部会清空确认态；删除中禁用扫描与清缓存入口。
- 确认条内按钮比 `size="sm"`（32px）再小一号：高 28px、水平 padding 8px，避免撑满确认条；确认条本身仍保持 32px 高，列表不跳动。
- **音纹对比阶段渐进出结果**：`runDuplicateScan` 新增可选 `AudioScanHooks`（`onCompareStart` / `onCompareProgress` / `onGroup`）。计算阶段仍只报指纹进度；进入对比后先清空上轮结果、切到 `phase: 'compare'`，然后每发现一组立即 `setScanGroups` 追加。对比用 scan.ts 内部新增的 `groupBySimilarityIncremental`（复制公共 `groupBySimilarity` 的贪心逻辑，约每 16ms 让出主线程、可取消）；组一旦形成即为最终结果，不会后续合并，因此可安全增量展示。公共 `groupBySimilarity` 未改动。
- 对比中且暂无结果时，结果区显示 `duplicate_compare_hint`（"正在对比音纹，发现重复会立即显示…"），不显示"暂无重复歌曲"空态。
- **独立试听播放器**：`usePreviewPlayer.ts` 新建独立 `HTMLAudioElement`，只播放当前标签去重结果中的本地文件（`groups.flatMap(g => g.items)` 作为本轮队列），完全不读写主播放器队列。迷你条 `MiniPlayer.tsx` 改为受控展示，只显示试听状态；没有试听会话时返回 null，不再显示外部正在播放的歌。点击试听、播放/暂停、下一首、拖动进度都在这个独立播放器内完成；文件加载失败只显示「播放失败 / 无法播放此文件，可能已移动或损坏」，不自动切歌。
- **与主播放器互斥**：开始试听时若主播放器在播放/缓冲则先暂停并记住状态；试听期间若主播放器被其他入口恢复，则暂停试听并放弃恢复标记；切换标签或音纹阈值、删除、清空缓存、关闭弹窗时调用 `preview.stop()`，停止试听并恢复主播放器原先的播放状态。
- 列表行高亮 `is-previewing` 改为跟随独立试听器的当前曲目（`preview.state.current?.key`），不再跟随主播放器。
- 旧的 `previewKey` + `trackPlayer.playMusic` 试听路径已移除。主播放器的 `playMusic` 本身确实不替换队列（已在则跳转，否则 append 到队尾），但去重试听不再依赖它。
- 新增 i18n：`duplicate_previewing`、`duplicate_preview_paused`、`duplicate_preview_failed`、`duplicate_preview_error`。
- **本地歌曲试听/播放崩溃修复**：本地歌只存在 `local_music` 表，`music_items` 可能没有记录，`musicSheet.getRawMusicItem` 原来返回 null，`playIndex` 退回无 `url` 的 slim，localPlugin 的 `addFileScheme(undefined)` 触发 `startsWith` 崩溃。现在 `musicSheet` 对 `platform === '本地'` 回退查 `local_music` 并补 `url`（`pathToFileURL`）、`localPath`、`fileSize`；IPC `GET_RAW_MUSIC_ITEM(S)` 与 `getMusicItemProvider` 共用该逻辑。`localPlugin.getMediaSource` 对缺失 `url` 返回 null 兜底。
- 音纹操作行最终形态：`[计算] [清空指纹缓存] 阈值 [Select]`；下一行合并显示 `指纹缓存占用: X · 指纹只需计算一次，再次对比将直接复用`。「重算所有音纹」按钮及其 i18n key 已删除。

---

## 二、待实施需求：被动相似检测

### 用户原话（2026-10/11 会话）

> 现在这个去重代码是主动触发的，能否在歌单里面的缓存（也就是开始播放各个源的时候，不要改变播放器原本去读取源的逻辑，仅在播放器自己缓存了一个完整歌曲的时候触发）去计算一下和本地库中是否存在相似，并标识在播放列表中。下载的时候弹窗提示一下已经存在相似歌曲、相似度，还在弹窗中提供播放和添加到下一曲中，方便用户鉴别。

### 需求拆解

1. 不再只靠手动打开去重弹窗，改为被动检测。
2. 触发条件：播放取源后**已有完整本地文件**时才检测；没有就不额外下载、不改播放取源。
3. 检测结果标识在播放列表（队列行）。
4. 下载时提示已存在的相似歌曲 + 相似度。
5. 提示弹窗内提供「播放」和「添加到下一曲」。

### 必须知道的事实（已调研，勿重复）

- **当前播放器不缓存整曲**：
  - 播放链路 `trackPlayer/index.ts` → `resolveSource` → `audioController.setTrackSource`，只是流式播放（HTMLAudioElement / hls.js / requestForwarder 代理）。
  - `systemUtil.getCacheSize/clearCache` 是 Chromium HTTP 缓存，不是完整歌曲文件。
  - 全仓库唯一完整写歌曲文件的地方是 `downloadManager`（用户主动下载）。
  - 因此「播放时已有完整缓存」目前只可能来自：已下载文件、或本地库文件。要覆盖在线播放必须新增旁路播放缓存。
- **播放优先用本地文件**：`trackPlayer.tryLocalSource()`（`index.ts:739-763`）通过 `downloadManager.isDownloaded()` 取路径，文件不存在会清理下载记录。
- **下载完成后的最终路径只能在完成事件里拿**：
  - `addTask` 返回的 `filePath` 不含扩展名；扩展名由响应 `Content-Type` 决定，同名还会加 `(1)`。
  - 完成事件 `completed` 的 `event.task.filePath` 才是最终路径；权威存储是 `media_meta.downloadData.path`。
- **播放队列项是 slim**：`IMusicItemSlim` 只有 platform/id/title/artist/album/duration/artwork，没有 `localPath`。队列标识必须用 `platform+id` 查映射，或用 `downloadManager.isDownloaded` / `mediaMeta.getMeta`。
- **指纹接口现状**（`src/infra/audioFingerprint/`）：
  - renderer：`checkBinary` / `calculateFingerprint` / `getFileHash` / `getCacheInfo` / `clearCache` / `pruneCache` / `loadMarks` / `saveMarks`。
  - **没有** `queryFingerprint` / `compare` / dry-run；`calculateFingerprint` 未命中会无条件写缓存。
  - 缓存文件 `fingerprint-cache.json`：`Record<绝对路径, { mtimeMs, size, fingerprint: number[], duration: number }>`，命中条件是路径 + mtime + size 全一致。
  - 版本标记 `version-marks.json`：组签名数组，复用 `detectVersionReason` / `buildVersionSignature`。
- **相似算法**（`src/infra/audioFingerprint/common/fingerprint.ts`）：
  - `hammingSimilarity(a, b, minSimilarity)`：只比较前 min 长度，SWAR popcount。
  - `groupBySimilarity` 是 O(n²)，时长差 > 15s 直接跳过（硬编码，不能传参）。
  - 阈值：strict 0.95 / standard 0.88 / loose 0.80（`scan.ts`）。
  - 版本识别：`detectVersionReason`（keyword / crosslang / cover）。
- **本地库**：
  - 主进程表 `local_music`，renderer 用 `localMusic.getAllMusicItems()`。
  - 两类项：纯本地歌（`platform='本地'`，id=md5(path)）和 App 下载歌（原平台 id，若下载目录被扫描）。
  - 完整项有 `localPath` / `fileSize`；slim 项没有。
- **下载入口只有两处**：
  - `DownloadButton`（`components/business/DownloadButton/index.tsx`）→ `downloadManager.addTask`。
  - 右键菜单 `MusicItemMenu.tsx` → `downloadManager.addTasksBatch`。
  - 目前**没有下载确认弹窗、没有下载中弹窗、下载完成没有全局 Toast**。
- **现成 UI 设施**：
  - `ConfirmModal`（支持 async onConfirm + loading）
  - `Toast`（支持 actionLabel/onAction）
  - `showModal` / `closeModal` + `modals/registry.ts`
  - `Badge` / `Chip`
  - 队列行 `QueueDrawer/index.tsx` 的 `QueueItemRow`，行高固定 48px。
  - `trackPlayer.addNext(items)` 已存在，可直接「添加到下一曲」。
  - 播放相似歌用 `trackPlayer.playMusic(item)`（会打断当前播放）。
  - 定位文件用 `systemUtil.showItemInFolder(path)`。

---

## 三、推荐方案

### 1. 总体架构

新增主进程 infra：`src/infra/similarity/`（common/constant、main/index、preload、renderer）。

放在主进程的原因：本地库、下载记录、指纹缓存、文件系统都在主进程；大库比对不能阻塞 renderer。

职责：

- 构建本地指纹索引（本地库 + 已下载 + 可选播放缓存）。
- 对单个文件/歌曲做相似检测。
- 结果落 SQLite 并推送 renderer。
- renderer 只负责徽标与弹窗。

数据流：

```
播放取源成功（不改逻辑）
  └─ 已有完整文件? ──> similarityManager.checkMusic()
旁路播放缓存完成 ─────> similarityManager.checkFile()
下载完成事件 ─────────> similarityManager.checkFile()
                              │
                              ├─ 读/算目标指纹
                              ├─ 时长预筛 + Hamming 比对
                              ├─ 写 similarity_matches
                              └─ 推送 renderer
                                        │
                          播放队列徽标 / 下载相似弹窗
```

### 2. 数据模型

内存索引项：

```ts
interface IndexedTrack {
    key: string;              // platform+id
    platform: string;
    musicId: string;
    title: string;
    artist: string;
    album?: string;
    duration: number;
    path: string;
    size: number;
    mtimeMs: number;
    fingerprint?: number[];
}
```

来源：`localMusic.getAllMusic()` + `mediaMeta.getAllDownloaded()`（+ 可选播放缓存）。同路径只保留一条，按 `platform+id` 去重。

SQLite 新表 `similarity_matches`：

```sql
source_platform, source_music_id,
similar_platform, similar_music_id,
similarity REAL,
match_type TEXT,        -- audio / tag / filename
version_reason TEXT,    -- keyword / crosslang / cover / null
updated_at INTEGER,
PRIMARY KEY (source_platform, source_music_id, similar_platform, similar_music_id)
```

只存 ≥ 0.80；UI 默认展示 ≥ 0.88；每首歌最多保留 top 3。

renderer atom：

```ts
similarityByKeyAtom: Map<string, SimilarityMatch[]>
similarityIndexingAtom: { running, done, total }
```

启动拉全量，之后走 IPC 增量事件。

### 3. 算法

- 复用 `hammingSimilarity` / `decodeFingerprint`，不重复实现。
- 排除自身：同 `platform+id` 或同路径。
- 时长预筛 `|Δduration| <= 15s`，再算 Hamming。
- ≥ 0.80 记候选，≥ 0.88 默认提示。
- `detectVersionReason` 标注「疑似版本差异」；用户手动标记过的版本组降级，不主动弹窗。
- 无 fpcalc 时降级为 title/artist/filename 匹配，不显示百分比，只显示「同名/同标签」。

### 4. 触发时机

- **播放**：`trackPlayer` 取源成功后，若已有完整本地文件 → `checkMusic()`，fire-and-forget，不 await，不阻塞播放；没有完整文件就不检测。
- **播放缓存完成**（可选阶段）：缓存服务发事件 → `checkFile()`。
- **下载完成**：监听 `completed` → 用最终 `filePath` → `checkFile()` → 命中则弹窗。只提示，不自动删除、不阻止下载。
- **下载前**（可选轻量预检）：只查已有结果或做元数据预检；不要为了检测临时拉整曲。
- **手动去重弹窗**保留，作为全库扫描入口。

### 5. 播放列表标识

- `QueueDrawer/index.tsx` 的 `QueueItemRow` 标题行右侧加 `SimilarityBadge`。
- 徽标：小图标 + `≈92%`，warn 色；hover 展示相似歌名；点击打开 `SimilarMusicModal`。
- 同一组件可复用到 `SongTable` 的 `statusColumn`，覆盖歌单页 / 本地音乐页。
- 队列行高 48px 不变。

### 6. 下载相似弹窗

新增 `DownloadSimilarModal`，注册到 `modals/registry.ts`。

内容：

- 标题：发现 N 首相似歌曲，最高 X%。
- 每项：标题 - 歌手、时长、文件大小、相似度、版本提示；操作「播放」「加入下一曲」「定位」。
- 底部：下载前为「继续下载 / 取消」；下载完成后为「关闭 / 删除刚下载的文件」。
- 同一目标歌只弹一次；批量下载合并为一条提示，避免弹窗轰炸。

### 7. 可选：旁路播放缓存

- 新增 `playCacheManager`，独立于 trackPlayer。
- `resolveSource` 返回后 fire-and-forget 调用，不改返回值、不 await。
- 跳过本地文件、已下载、m3u8/加密流；只缓存直链音频。
- 写入 `userData/play-cache/`，临时文件 + rename；带原 source 的 headers/UA。
- 单并发、单曲大小上限、总量上限、LRU 清理，设置页可开关/清空。
- 缓存路径记 `media_meta.playCacheData` 或新表 `play_cache`。
- 失败静默，不影响播放。

### 8. 性能与边界

- 指纹计算独立低优先级队列（1–2 并发），与手动去重扫描共享锁。
- 本地索引启动后延迟构建（约 30s），本地库变化增量更新。
- 大库用 duration 分桶 + 15s 预筛。
- 同一首歌重复播放只检测一次（in-flight Map）。
- 下载目录被扫描进本地库时排除自身。
- 文件删除 / 缓存清理 / 本地库删除 → 清理匹配记录。
- 无 fpcalc、文件损坏、权限不足 → 降级或静默。

### 9. 分阶段落地

| 阶段 | 内容 | 改动量 |
| --- | --- | --- |
| P0 | `similarity` infra、SQLite 表、IPC、指纹索引、check API | 中 |
| P1 | 播放队列徽标 + `SimilarMusicModal` + 全量结果同步 | 中 |
| P2 | 下载完成事件 → 相似弹窗 | 小 |
| P3 | 下载前轻量预检（元数据匹配） | 小 |
| P4 | 旁路播放缓存 + 设置项（可选） | 大 |
| P5 | 性能优化、清理策略、批量提示 | 中 |

建议先做 P0–P2；确认体验后再做 P4。

---

## 四、待用户确认的 4 个点

实施前必须确认：

1. 是否新增旁路播放缓存？不新增则「播放时检测」只覆盖已下载文件。
2. 下载弹窗时机：推荐「下载完成后」给精确相似度，「下载前」只做轻量元数据预检。
3. 标识范围：只标播放队列，还是歌单列表 / 本地音乐列表也标？
4. 提示策略：默认阈值 0.88、只提示不阻止下载；是否在设置里提供阈值和开关？

---

## 五、实施注意事项（踩坑清单）

- **不要改播放取源逻辑**：`resolveSource` 的返回值、音质回退、`tryLocalSource` 全部保持原样；检测只能旁路。
- **不要 await 检测**：播放路径上加任何 await 都会拖慢起播。
- **下载路径不要提前拼**：扩展名和重名后缀在下载完成后才确定。
- **队列项没有 localPath**：用 `platform+id` 查相似映射或 `isDownloaded`。
- **`toScanItems` 会丢弃无 localPath 的项**：在线歌没有本地文件时不能走现有 `runDuplicateScan`。
- **`groupBySimilarity` 硬编码 15s 容差**：需要自定义容差就自己写候选筛，不要改公共函数破坏手动去重。
- **`calculateFingerprint` 未命中会写缓存**：这是现有行为；如要 dry-run 需给 main handler 加 `noCache` 参数。
- **版本标记要尊重**：用户手动标记过的组不要反复弹「重复」。
- **节流弹窗**：批量下载/连续播放时合并提示。
- **i18n**：新文案加到 `res/lang/zh-CN.json`、`zh-TW.json`、`en-US.json`，键名遵守现有 `local_music.duplicate_*` 风格。
- **样式规范**：BEM + 全局 SCSS，状态类用 `is-*`，主题色用 CSS 变量。
- **验证**：改完跑 `npx prettier --check <files>`、`npx eslint <files>`、`npx tsc --noEmit -p tsconfig.json`。

---

## 六、关键文件索引

| 主题 | 路径 |
| --- | --- |
| 播放编排 | `src/renderer/mainWindow/core/trackPlayer/index.ts` |
| 音频控制 | `src/renderer/mainWindow/core/trackPlayer/audioController.ts` |
| 播放队列 | `src/renderer/mainWindow/core/trackPlayer/playQueue.ts` |
| 队列 UI | `src/renderer/mainWindow/components/layout/QueueDrawer/index.tsx` |
| 歌单表格 | `src/renderer/mainWindow/components/business/SongTable/index.tsx` |
| 下载按钮 | `src/renderer/mainWindow/components/business/DownloadButton/index.tsx` |
| 歌曲右键菜单 | `src/renderer/mainWindow/components/business/contextMenus/MusicItemMenu.tsx` |
| 下载主进程 | `src/infra/downloadManager/main/index.ts` |
| 下载写文件 | `src/infra/downloadManager/main/downloadTask.ts` |
| 下载 renderer | `src/infra/downloadManager/renderer.ts` |
| mediaMeta | `src/infra/mediaMeta/main.ts`、`renderer.ts` |
| 指纹主进程 | `src/infra/audioFingerprint/main.ts` |
| 指纹算法 | `src/infra/audioFingerprint/common/fingerprint.ts` |
| 指纹 renderer | `src/infra/audioFingerprint/renderer.ts` |
| 去重弹窗 | `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/index.tsx` |
| 去重扫描 | `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/scan.ts` |
| 去重状态 | `src/renderer/mainWindow/components/business/modals/DuplicateMusicModal/store.ts` |
| 本地库主进程 | `src/infra/localMusic/main/index.ts` |
| 本地库 renderer | `src/infra/localMusic/renderer.ts` |
| 本地库 store | `src/renderer/mainWindow/pages/LocalMusicPage/store.ts` |
| 数据库迁移 | `src/infra/database/main.ts` |
| 弹窗注册 | `src/renderer/mainWindow/components/business/modals/registry.ts` |
| 主进程初始化 | `src/main/index.ts` |

---

## 七、维护规则

- 每完成一个阶段，更新「当前工作区状态」和「分阶段落地」的勾选状态。
- 用户确认「待确认决策」后，把结论写进本文件，删掉对应待确认项。
- 新发现的播放/下载/指纹链路事实，追加到「必须知道的事实」，不要只留在对话里。
- 如果实际实现与本文方案偏离，以实现为准并回头更新本文件。
