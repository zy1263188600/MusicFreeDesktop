import * as Comlink from "comlink";
import * as chokidar from "chokidar";
import fs from "fs/promises";
import path from "path";
import { supportLocalMediaType } from "@/common/constant";
import debounce from "lodash.debounce";
import { parseLocalMusicItem } from "@/common/file-util";
import { setInternalData } from "@/common/media-util";

let watcher: chokidar.FSWatcher;

const addedMusicItems: IMusic.IMusicItem[] = [];
const removedFilePaths: string[] = [];

let _onAdd: (musicItems: IMusic.IMusicItem[]) => void;
let _onRemove: (filePaths: string[]) => void;

async function setupWatcher(initPaths?: string[]) {
    watcher = chokidar.watch(initPaths ?? [], {
        depth: 10,
        persistent: true,
        ignorePermissionErrors: true,
    });

    watcher.on("add", async (fp, stats) => {
        if (
            stats.isFile() &&
      supportLocalMediaType.some((postfix) => fp.endsWith(postfix))
        ) {
            const musicItem = await parseLocalMusicItem(fp);
            musicItem.$$localPath = fp;
            setInternalData<IMusic.IMusicItemInternalData>(
                musicItem,
                "downloadData",
                {
                    path: fp,
                    quality: "standard",
                },
            );
            addedMusicItems.push(musicItem);
            syncAddedMusic();
        }
    });

    watcher.on("unlink", (fp) => {
        if (supportLocalMediaType.some((postfix) => fp.endsWith(postfix))) {
            removedFilePaths.push(fp);
            syncRemovedFilePaths();
        }
    });
}

const syncAddedMusic = debounce(
    () => {
        const copyOfAddedMusicItems = [...addedMusicItems];
        addedMusicItems.length = 0;
        _onAdd?.(copyOfAddedMusicItems);
    },
    500,
    {
        leading: false,
        trailing: true,
    },
);

const syncRemovedFilePaths = debounce(
    () => {
        const copyOfRemovedFilePaths = [...removedFilePaths];
        removedFilePaths.length = 0;
        _onRemove?.(copyOfRemovedFilePaths);
    },
    500,
    {
        leading: false,
        trailing: true,
    },
);

async function changeWatchPath(addPaths?: string[], rmPaths?: string[]) {
    console.log(addPaths, rmPaths);
    try {
        if (addPaths?.length) {
            watcher.add(addPaths);
        }
        if (rmPaths?.length) {
            watcher.unwatch(rmPaths);
            /**
       * chokidar的bug: https://github.com/paulmillr/chokidar/issues/1027
       * unwatch之后重新watch不会触发文件更新
       */
            rmPaths.forEach((it) => {
                // @ts-ignore
                const watchedDirEntry = watcher._watched.get(it);
                if (watchedDirEntry) {
                    // 移除所有子节点的监听
                    watchedDirEntry._removeWatcher(
                        path.dirname(it),
                        path.basename(it),
                        true,
                    );
                }
                // watcher._watched.delete(it);
            });
        }
    // console.log("WATCH PATH CHANGED", addPaths, rmPaths, watcher);
    } catch (e) {
        console.log(e);
    }
}

async function onAdd(fn: (musicItems: IMusic.IMusicItem[]) => void) {
    _onAdd = fn;
}

async function onRemove(fn: (filePaths: string[]) => void) {
    _onRemove = fn;
}

// 手动重扫指定目录：递归收集音频文件并解析，用于用户主动刷新（比如关软件期间的增删没同步上）
// 与 chokidar 实时监听互补；深度上限 10，与 watch 保持一致
async function rescanDirs(dirs: string[]): Promise<IMusic.IMusicItem[]> {
    const out: IMusic.IMusicItem[] = [];

    async function walk(dir: string, depth: number) {
        if (depth > 10) return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fp = path.join(dir, entry.name);
            try {
                if (entry.isDirectory()) {
                    await walk(fp, depth + 1);
                } else if (
                    entry.isFile() &&
                    supportLocalMediaType.some((postfix) => fp.endsWith(postfix))
                ) {
                    const musicItem = await parseLocalMusicItem(fp);
                    musicItem.$$localPath = fp;
                    setInternalData<IMusic.IMusicItemInternalData>(
                        musicItem,
                        "downloadData",
                        {
                            path: fp,
                            quality: "standard",
                        },
                    );
                    out.push(musicItem);
                }
            } catch {
                // 单个文件/目录失败跳过，不中断整批
            }
        }
    }

    for (const dir of dirs) {
        await walk(dir, 0);
    }
    return out;
}

Comlink.expose({
    setupWatcher,
    changeWatchPath,
    onAdd,
    onRemove,
    rescanDirs,
});
