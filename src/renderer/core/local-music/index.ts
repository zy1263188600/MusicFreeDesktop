import localMusicListStore from "./store";
import { getUserPreferenceIDB } from "@/renderer/utils/user-perference";
import * as Comlink from "comlink";
import PQueue from "p-queue";
import musicSheetDB from "../db/music-sheet-db";
import { getGlobalContext } from "@/shared/global-context/renderer";
import { fsUtil } from "@shared/utils/renderer";

type ProxyMarkedFunction<T extends (...args: any) => void> = T &
    Comlink.ProxyMarked;

type IMusicItemWithLocalPath = IMusic.IMusicItem & { $$localPath: string };

interface ILocalFileWatcherWorker {
    setupWatcher: (initPaths?: string[]) => Promise<void>;
    changeWatchPath: (addPaths?: string[], rmPaths?: string[]) => Promise<void>;
    rescanDirs: (dirs: string[]) => Promise<IMusicItemWithLocalPath[]>;
    onAdd: (
        cb: ProxyMarkedFunction<
            (musicItems: Array<IMusicItemWithLocalPath>) => Promise<void>
        >
    ) => void;
    onRemove: (
        cb: ProxyMarkedFunction<(filePaths: string[]) => Promise<void>>
    ) => void;
}

let localFileWatcherWorker: ILocalFileWatcherWorker;

function isSubDir(parent: string, target: string) {
    const relative = window.path.relative(parent, target);
    return (
        relative && !relative.startsWith("..") && !window.path.isAbsolute(relative)
    );
}

async function partitionExisting(
    items: IMusicItemWithLocalPath[],
): Promise<{ validMusic: IMusicItemWithLocalPath[]; staleKeys: Array<[string, string]> }> {
    const queue = new PQueue({ concurrency: 20 });
    const flags = await Promise.all(
        items.map((it) => queue.add(() => fsUtil.isFile(it.$$localPath))),
    );
    const validMusic: IMusicItemWithLocalPath[] = [];
    const staleKeys: Array<[string, string]> = [];
    items.forEach((it, i) => {
        if (flags[i]) validMusic.push(it);
        else staleKeys.push([it.platform, it.id]);
    });
    return { validMusic, staleKeys };
}

async function setupLocalMusic() {
    try {
        const localWatchDir =
            (await getUserPreferenceIDB("localWatchDirChecked")) ?? [];


        const localFileWatcherWorkerPath =
            getGlobalContext().workersPath.localFileWatcher;
        if (localFileWatcherWorkerPath) {
            const worker = new Worker(localFileWatcherWorkerPath);
            localFileWatcherWorker = Comlink.wrap(worker);
            await localFileWatcherWorker.setupWatcher(localWatchDir);
        }

        const allMusic = await musicSheetDB.localMusicStore.toArray();

        // 对账：软件关闭期间删掉的歌，watcher 收不到 unlink 事件，DB 里会残留幽灵条目
        const { validMusic, staleKeys } = await partitionExisting(allMusic);
        if (staleKeys.length) {
            await musicSheetDB.localMusicStore.bulkDelete(staleKeys as any);
        }

        localMusicListStore.setValue(validMusic);
        localFileWatcherWorker.onAdd(
            Comlink.proxy(async (musicItems: IMusicItemWithLocalPath[]) => {
                await musicSheetDB.transaction(
                    "rw",
                    musicSheetDB.localMusicStore,
                    async () => {
                        await musicSheetDB.localMusicStore.bulkPut(musicItems);
                        const allMusic = await musicSheetDB.localMusicStore.toArray();
                        localMusicListStore.setValue(allMusic);
                    },
                );
            }),
        );

        localFileWatcherWorker.onRemove(
            Comlink.proxy(async (filePaths: string[]) => {
                await musicSheetDB.transaction(
                    "rw",
                    musicSheetDB.localMusicStore,
                    async () => {
                        const tobeDeletedFilePaths = new Set(filePaths);
                        const cachedLocalMusic = localMusicListStore.getValue();
                        const tobeDeletedPrimaryKeys: any[] = [];
                        const newCachedLocalMusic: IMusicItemWithLocalPath[] = [];
                        cachedLocalMusic.forEach((it) => {
                            if (tobeDeletedFilePaths.has(it.$$localPath)) {
                                tobeDeletedPrimaryKeys.push([it.platform, it.id]);
                            } else {
                                newCachedLocalMusic.push(it);
                            }
                        });
                        await musicSheetDB.localMusicStore.bulkDelete(
                            tobeDeletedPrimaryKeys,
                        );
                        localMusicListStore.setValue(newCachedLocalMusic);
                    },
                );
            }),
        );
    } catch {
    }
}

async function changeWatchPath(logs: Map<string, "add" | "delete">) {
    // 对所有的要删除的路径
    const tobeDeletedPaths: string[] = [];
    const tobeAddedPaths: string[] = [];
    logs.forEach((action, dirPath) => {
        if (action === "delete") {
            tobeDeletedPaths.push(dirPath);
        } else {
            tobeAddedPaths.push(dirPath);
        }
    });

    // 删除所有子路径的
    if (tobeDeletedPaths.length) {
        await musicSheetDB.transaction(
            "rw",
            musicSheetDB.localMusicStore,
            async () => {
                const localFiles = localMusicListStore.getValue();
                const tobeDeletedItems = localFiles
                    .filter((it) =>
                        tobeDeletedPaths.some((deletePath) =>
                            isSubDir(deletePath, it.$$localPath),
                        ),
                    )
                    .map((it) => [it.platform, it.id]);
                await musicSheetDB.localMusicStore.bulkDelete(tobeDeletedItems);
            },
        );

        localMusicListStore.setValue(await musicSheetDB.localMusicStore.toArray());
    }
    // 通知
    localFileWatcherWorker.changeWatchPath(tobeAddedPaths, tobeDeletedPaths);
}

// 手动重扫指定目录：补新增、清已删，返回统计供 UI 提示
async function rescanSelectedDirs(dirs: string[]): Promise<{ scanned: number; added: number; removed: number }> {
    const fresh = await localFileWatcherWorker.rescanDirs(dirs);
    const cached = localMusicListStore.getValue();
    const cachedKeys = new Set(cached.map((it) => `${it.platform}+${it.id}`));
    const added = fresh.filter((it) => !cachedKeys.has(`${it.platform}+${it.id}`)).length;
    const freshPaths = new Set(fresh.map((it) => it.$$localPath));
    const staleKeys = cached
        .filter((it) => !freshPaths.has(it.$$localPath) && dirs.some((dir) => isSubDir(dir, it.$$localPath)))
        .map((it) => [it.platform, it.id]);
    await musicSheetDB.transaction(
        "rw",
        musicSheetDB.localMusicStore,
        async () => {
            await musicSheetDB.localMusicStore.bulkPut(fresh);
            if (staleKeys.length) {
                await musicSheetDB.localMusicStore.bulkDelete(staleKeys as any);
            }
            localMusicListStore.setValue(await musicSheetDB.localMusicStore.toArray());
        },
    );
    return { scanned: fresh.length, added, removed: staleKeys.length };
}

// async function syncLocalMusic() {
//   ipcRendererSend("sync-local-music");
// }

export default {
    setupLocalMusic,
    // syncLocalMusic,
    changeWatchPath,
    rescanSelectedDirs,
};
