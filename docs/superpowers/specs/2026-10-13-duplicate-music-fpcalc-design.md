# 歌曲去重（对标 Duplicate Cleaner 5，真音纹 fpcalc）设计文档

日期：2026-10-13
状态： brainstorming 已确认，待评审 spec 后进入 writing-plans
用户已确认：B 直接上 fpcalc；4 段设计均 OK

## 1. 背景与目标

用户已在本地音乐页加「歌曲去重」按钮（`local-music-view/index.tsx`），点击弹 `DuplicateMusic` 弹窗。
现有骨架 `src/shared/calculates-fingerprints/` 跑不通，需重写。目标是参考 Duplicate Cleaner 5，
对本地音乐库做可切换多模式去重，支持预览 + 手动删除。

非目标：在线歌单去重；自动删除无确认；歌词/封面去重。

## 2. 现状问题（已实测）

- `src/shared/calculates-fingerprints/main.ts` 在主进程用了 `window`，缺 `fs` 导入，
  `computeAudioFingerprint` 未定义，`fs.existsSync` 不可用。
- 该 shared 模块未在 `src/main/index.ts` setup，也未在 `src/preload/common-preload.ts` 注册，
  渲染层 `window['@shared/fingerprint']` 为 undefined。
- `DuplicateMusic/index.tsx` 组件名误写 `WatchLocalDir`，标题复用 `scan_local_music`，
  只有 Confirm 按钮调写死的 `/path/to/audio.mp3`，无进度、无分组、无删除。
- 数据源明确：`localMusicListStore: Array<IMusicItem & {$$localPath: string}>`，
  已有 `music-metadata`、`p-queue`、`better-sqlite3`、`rimraf` 依赖可用。

## 3. 总体架构（方案 B）

```text
resources/bin/{win-x64,mac-arm64,linux-x64}/fpcalc(.exe)
        │ spawn
src/shared/audio-fingerprint/main.ts  (FingerprintService: 单文件指纹 + 缓存)
        │ ipcMain.handle("@shared/fingerprint/calculate")
src/shared/audio-fingerprint/preload.ts (contextBridge expose)
src/shared/audio-fingerprint/renderer.ts (calculateFingerprint 封装)
src/shared/audio-fingerprint/common.ts (类型 + Hamming 相似度 + 归一化)
        │
DuplicateMusic 弹窗 (模式 Tab + 阈值 + 进度 + 分组 + 选择助手 + 删除)
        │ p-queue(并发4) 逐首 invoke
localMusicListStore / musicSheetDB.localMusicStore (删后同步)
```

- 重命名并重写模块：删除 `src/shared/calculates-fingerprints/`，新建 `src/shared/audio-fingerprint/`（含下述 4 个文件），preload key 保持 `@shared/fingerprint` 不变以兼容已有渲染层调用。
- 二进制：从 acoustid.org/chromaprint 下载各平台 fpcalc，`forge.config.ts` 加 `extraResource`。
  路径解析：`app.isPackaged ? path.join(process.resourcesPath, "bin/...") : path.join(app.getAppPath(), "resources/bin/...")`。
- 注册：`src/main/index.ts` bootstrap 中 `FingerprintService.setup()`；
  `src/preload/common-preload.ts` 加 `import "@shared/audio-fingerprint/preload"`。
- 缓存：`app.getPath("userData")/fingerprint-cache.json`，
  key=文件绝对路径，value=`{mtimeMs, size, fingerprint, duration}`，
  mtime/size 不变直接命中。全量万首必须靠缓存，否则每首 2-5s 不可接受。

## 4. 扫描模式（4 种可切换，对标 DC5）

| 模式 | 方法 | 说明 |
|---|---|---|
| 音纹相似（默认） | fpcalc FINGERPRINT + duration | 解码后 Hamming 距离 + 时长容差；阈值三档：严格≤5%、标准≤12%、宽松≤20% |
| 完全相同 | 流式 MD5/SHA256（主进程读文件） | 不走 fpcalc，秒出，抓字节级重复 |
| 相同标签 | 归一化 title+artist+album + duration±2s | 归一化=trim/lower/去标点/全半角；抓不同文件同首歌 |
| 相同文件名 | basename（可选去扩展名/ lower） | 最轻量 |

- 音纹相似度实现放在 `common.ts`：`decodeFingerprintToBits()` + `hammingSimilarity()` +
  `groupBySimilarity(items, threshold)`。fpcalc 输出为压缩指纹字符串，需按 Chromaprint 格式解码再比对。
- 渲染层流程：取 `localMusicListStore.getValue()` → 按模式预分组（hash/标签模式无需 fpcalc 直接出结果）
  → 音纹模式用 `p-queue` 并发 4 调 `calculate`，进度 `done/total`，支持取消（queue.clear + 忽略后续）。

## 5. UI/交互（DuplicateMusic 弹窗）

沿用 `Base + shadow backdrop-color`，内容重做：

- 顶栏：4 个 Tab + 音纹阈值滑杆（仅音纹模式显示）+ 扫描按钮。
- 扫描中：进度条 + `正在分析 x/y` + 取消 + 跳过计数。
- 结果：可折叠分组，组头 `组N · M首 · 可释放xxMB`；行显示 标题/歌手/时长/文件大小/路径，码率仅当 `music-metadata` 已解析出时才显示；
  行操作：试听（复用 track-player）、打开所在文件夹（dialogUtil/shell）、勾选。
- 选择助手（一键勾选）：每组保留第一首 / 保留最高码率 / 保留最短路径；全选/清空。
- 底部：`彻底删除文件`（rimraf + DB/store 移除）vs `仅从音乐库移除`（保留文件），
  均经 `Reconfirm` 二次确认；执行后刷新 store，无结果时 Empty 态。
- i18n：补 `local_music_page.duplicate_music.*` 及 modal 文案到 `res/lang/zh-CN/en-US/zh-TW.json`。
- 复用样式变量（`--primaryColor` 等），弹窗尺寸沿用现有 90% 容器 + 复用 WatchLocalDir 的 row 样式。

## 6. 删除与数据一致性

- 删文件：渲染层经新增 IPC `@shared/fingerprint/delete-files` 请求主进程执行，主进程用 `rimraf` 删除磁盘文件；
  成功后 `musicSheetDB.localMusicStore.bulkDelete([platform,id])` + `localMusicListStore.setValue(剩余)`。
- 仅移除：只走 DB/store，不碰磁盘。
- 失败（占用/权限）单行标红 + toast，不中断批量；删后缓存中对应 key 失效删除。

## 7. 异常处理

- fpcalc 缺失/无执行权限：扫描前 `checkBinary()`，弹窗提示下载链接 + 日志。
- 不支持格式/损坏：catch 后计入跳过列表展示，不中断。
- 扫描中关闭弹窗：取消 IPC/队列回调（AbortController / queue.clear + token）。
- 缓存失效：mtime/size 变化重算；JSON 损坏则重建。
- 主进程 spawn 超时（单首 >60s）kill + 记跳过。

## 8. 验证计划

- 样本：3 组本地文件（a. 同文件复制两份 b. 同一首 mp3-128k + flac c. 不同歌同名）分别跑 4 模式，
  断言：完全相同只命中 a；音纹标准档命中 a+b；标签命中 b(+c 若标签同)；文件名按预期。
- 删除演练：勾选删除后 `localMusicListStore` 长度、DB `toArray()`、磁盘文件三者一致。
- 工程：`tsc --noEmit`、`eslint ./src` 通过；打包后验证 `extraResource` 二进制可执行。

## 9. 实施顺序（给 plan 用）

1. 二进制落位 + forge extraResource + 路径解析。
2. `audio-fingerprint` common/main/preload/renderer + 注册 + 缓存。
3. 相似度/分组纯函数（可单测）。
4. DuplicateMusic 弹窗 UI（Tab/进度/分组/选择助手/删除）。
5. 删除链路 + i18n + 样本验证。

## 10. 开放风险

- fpcalc 多平台二进制体积（每平台约 3-6MB）及杀软误报。
- 指纹模糊比对为 Chromaprint 压缩格式解码，阈值需用真实曲库微调。
- 万首全量首次扫描耗时仍长（缓存+并发只能缓解，需明确提示用户）。
