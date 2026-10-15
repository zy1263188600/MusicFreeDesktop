import {
    getUserPreferenceIDB,
    setUserPreferenceIDB,
} from "@/renderer/utils/user-perference";
import Base from "../Base";
import "./index.scss";
import { hideModal } from "../..";
import { useEffect, useMemo, useRef, useState } from "react";
import Condition from "@/renderer/components/Condition";
import Empty from "@/renderer/components/Empty";
import SvgAsset from "@/renderer/components/SvgAsset";
import Checkbox from "@/renderer/components/Checkbox";
import localMusic from "@/renderer/core/local-music";
import localMusicListStore from "@/renderer/core/local-music/store";
import { useTranslation } from "react-i18next";
import { dialogUtil } from "@shared/utils/renderer";
import { toast } from "react-toastify";


function isSubDir(parent: string, target: string) {
    const relative = window.path.relative(parent, target);
    return (
        relative && !relative.startsWith("..") && !window.path.isAbsolute(relative)
    );
}

interface ISubDirStat {
    /** 子目录完整路径 */
    fullPath: string;
    /** 相对监听目录的展示路径 */
    displayPath: string;
    /** 该子目录下（含更深层）歌曲数 */
    count: number;
}

export default function WatchLocalDir() {
    // 全部的文件夹
    const [localDirs, setLocalDirs] = useState<string[]>([]);
    // 选中的文件夹
    const [checkedDirs, setCheckedDirs] = useState(new Set<string>());
    const [rescanning, setRescanning] = useState(false);
    // 刷新结果常驻展示在弹窗内，避免 toast 被遮罩/自动消失后用户看不到
    const [lastResult, setLastResult] = useState<string | null>(null);
    const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
    const changeLogRef = useRef(new Map<string, "add" | "delete">()); // key: path; value: op
    const { t } = useTranslation();

    const localMusicList = localMusicListStore.useValue();

    useEffect(() => {
        (async () => {
            const allDirs = (await getUserPreferenceIDB("localWatchDir")) ?? [];
            const checked =
                (await getUserPreferenceIDB("localWatchDirChecked")) ?? [];
            const allDirsSet = new Set(allDirs);
            const validChecked = checked.filter((it) => allDirsSet.has(it));
            setLocalDirs([...allDirsSet]);
            setCheckedDirs(new Set(validChecked));
        })();
    }, []);

    // 每个监听目录的歌曲数（含子目录递归）+ 子目录列表（从已有歌曲路径派生）
    // 两阶段聚合：先按歌曲所在目录统计直属数量，再向上汇总，避免 S*Sub 次重复 relative 计算
    const dirStats = useMemo(() => {
        const counts = new Map<string, number>();
        const subDirSets = new Map<string, Set<string>>();
        localDirs.forEach((dir) => {
            counts.set(dir, 0);
            subDirSets.set(dir, new Set<string>());
        });
        if (!localDirs.length || !localMusicList?.length) {
            return { counts, subDirs: new Map<string, ISubDirStat[]>() };
        }
        // 阶段1：直属目录歌曲数
        const directCount = new Map<string, number>();
        localMusicList.forEach((item) => {
            const songPath = (item as { $$localPath?: string }).$$localPath;
            if (!songPath) return;
            const songDir = window.path.dirname(songPath);
            directCount.set(songDir, (directCount.get(songDir) ?? 0) + 1);
        });
        const songDirs = [...directCount.keys()];
        // 阶段2：汇总到每个监听目录，并收集子目录集合（含中间层级）
        localDirs.forEach((dir) => {
            let total = 0;
            const subs = subDirSets.get(dir) ?? new Set<string>();
            subDirSets.set(dir, subs);
            songDirs.forEach((songDir) => {
                const n = directCount.get(songDir) ?? 0;
                if (songDir === dir) {
                    total += n;
                } else if (isSubDir(dir, songDir)) {
                    total += n;
                    let cur = songDir;
                    for (let i = 0; i < 12; i++) {
                        subs.add(cur);
                        if (cur === dir) break;
                        const parent = window.path.dirname(cur);
                        if (parent === cur) break;
                        cur = parent;
                        if (!isSubDir(dir, cur) && cur !== dir) break;
                    }
                }
            });
            counts.set(dir, total);
        });
        const subDirs = new Map<string, ISubDirStat[]>();
        subDirSets.forEach((set, dir) => {
            const list: ISubDirStat[] = [...set]
                .sort((a, b) => a.localeCompare(b))
                .map((fullPath) => {
                    let count = 0;
                    // 子目录计数复用 directCount：累加所有位于其下的直属目录数量
                    directCount.forEach((n, songDir) => {
                        if (songDir === fullPath || isSubDir(fullPath, songDir)) {
                            count += n;
                        }
                    });
                    return {
                        fullPath,
                        displayPath:
                            window.path.relative(dir, fullPath) || fullPath,
                        count,
                    };
                });
            subDirs.set(dir, list);
        });
        return { counts, subDirs };
    }, [localDirs, localMusicList]);

    const toggleExpand = (dir: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(dir)) {
                next.delete(dir);
            } else {
                next.add(dir);
            }
            return next;
        });
    };

    return (
        <Base defaultClose>
            <div className="modal--watch-local-dir-container shadow backdrop-color">
                <Base.Header>{t("modal.scan_local_music")}</Base.Header>
                <div className="modal--body-container">
                    <div className="modal--body-container-title">
                        <span>{t("modal.scan_local_music_hint")}</span>
                        <div className="title-actions">
                            <div
                                role="button"
                                data-type="normalButton"
                                onClick={async () => {
                                    const result = await dialogUtil.showOpenDialog({
                                        title: t("modal.scan_local_music"),
                                        properties: ["openDirectory", "createDirectory"],
                                    });
                                    if (!result.canceled) {
                                        const selected = result.filePaths[0];
                                        if (!localDirs.includes(selected)) {
                                            const changeLog = changeLogRef.current;
                                            setCheckedDirs((prev) => {
                                                return new Set([...prev, selected]);
                                            });
                                            setLocalDirs((prev) => [...prev, selected]);
                                            changeLog.set(selected, "add");
                                        }
                                    }
                                }}
                            >
                                {t("modal.add_folder")}
                            </div>
                            <div
                                role="button"
                                data-type="normalButton"
                                className="refresh-btn"
                                data-scanning={rescanning}
                                data-disabled={rescanning}
                                onClick={async () => {
                                    if (rescanning) return;
                                    const dirs = [...checkedDirs];
                                    if (!dirs.length) {
                                        toast.info("请先勾选要刷新的文件夹");
                                        return;
                                    }
                                    setRescanning(true);
                                    setLastResult(null);
                                    try {
                                        const result = await localMusic.rescanSelectedDirs(dirs);
                                        const msg = `刷新完成：扫描 ${result.scanned} 首，新增 ${result.added} 首，清理 ${result.removed} 首`;
                                        setLastResult(msg);
                                        toast.success(msg);
                                    } catch {
                                        setLastResult("刷新失败");
                                        toast.error("刷新失败");
                                    } finally {
                                        setRescanning(false);
                                    }
                                }}
                            >
                                <span className="scan-spinner" />
                                <span className="scan-sheen" />
                                <span className="scan-label">{rescanning ? "刷新中..." : "刷新"}</span>
                            </div>
                        </div>
                    </div>
                    {lastResult ? (
                        <div className="rescan-result-bar">{lastResult}</div>
                    ) : null}
                    <div className="modal--body-scan-content backdrop-color">
                        <Condition
                            condition={localDirs.length}
                            falsy={
                                <Empty
                                    style={{
                                        minHeight: "200px",
                                    }}
                                ></Empty>
                            }
                        >
                            {localDirs.map((item) => {
                                const isChecked = checkedDirs.has(item);
                                const songCount = dirStats.counts.get(item) ?? 0;
                                const subList = dirStats.subDirs.get(item) ?? [];
                                const expanded = expandedDirs.has(item);

                                return (
                                    <div className="dir-group" key={item}>
                                        <div
                                            className="row-container"
                                            onClick={() => {
                                                setCheckedDirs((prev) => {
                                                    const changeLog = changeLogRef.current;
                                                    const itemChangeLog = changeLog.get(item);
                                                    const isChecked = prev.has(item);
                                                    // 如果此次没有任何变动，说明是旧有的，此时需要删除监听
                                                    if (!itemChangeLog) {
                                                        changeLog.set(item, isChecked ? "delete" : "add");
                                                    } else if (
                                                        (itemChangeLog === "add" && isChecked) ||
                                                        (itemChangeLog === "delete" && !isChecked)
                                                    ) {
                                                        changeLog.delete(item);
                                                    }

                                                    if (isChecked) {
                                                        prev.delete(item);
                                                    } else {
                                                        prev.add(item);
                                                    }
                                                    return new Set(prev);
                                                });
                                            }}
                                        >
                                            {subList.length ? (
                                                <div
                                                    role="button"
                                                    className="expand-toggle"
                                                    title={expanded ? "收起子目录" : "展开子目录"}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleExpand(item);
                                                    }}
                                                >
                                                    <SvgAsset
                                                        iconName={
                                                            expanded
                                                                ? "chevron-down"
                                                                : "chevron-right"
                                                        }
                                                    ></SvgAsset>
                                                </div>
                                            ) : (
                                                <div className="expand-toggle expand-toggle--empty" />
                                            )}
                                            <Checkbox
                                                checked={isChecked}
                                                style={{
                                                    color: isChecked ? "var(--primaryColor)" : undefined,
                                                }}
                                            ></Checkbox>
                                            <div className="title" title={item}>{item}</div>
                                            <div className="song-count" title={`共 ${songCount} 首（含子目录）`}>
                                                {songCount} 首
                                            </div>
                                            <div
                                                role="button"
                                                className="delete-path"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    const changeLog = changeLogRef.current;
                                                    const itemChangeLog = changeLog.get(item);
                                                    // 如果此次没有任何变动，说明是旧有的，此时需要删除监听
                                                    if (!itemChangeLog) {
                                                        changeLog.set(item, "delete");
                                                    } else if (itemChangeLog === "add") {
                                                        // 此次新增，但是被删掉了
                                                        changeLog.delete(item);
                                                        console.log("heredelete", changeLog);
                                                    }

                                                    setLocalDirs((prev) =>
                                                        prev.filter((it) => it !== item),
                                                    );
                                                    setCheckedDirs((prev) => {
                                                        prev.delete(item);
                                                        return new Set(prev);
                                                    });
                                                }}
                                            >
                                                <SvgAsset iconName="trash"></SvgAsset>
                                            </div>
                                        </div>
                                        {expanded
                                            ? subList.map((sub) => (
                                                <div
                                                    className="row-container sub-row"
                                                    key={sub.fullPath}
                                                    title={sub.fullPath}
                                                >
                                                    <div className="sub-indent" />
                                                    <div className="title sub-title">
                                                        {sub.displayPath}
                                                    </div>
                                                    <div className="song-count">
                                                        {sub.count} 首
                                                    </div>
                                                </div>
                                            ))
                                            : null}
                                    </div>
                                );
                            })}
                        </Condition>
                    </div>
                </div>
                <div className="footer-options">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={async () => {
                            setUserPreferenceIDB("localWatchDir", localDirs);
                            setUserPreferenceIDB("localWatchDirChecked", [...checkedDirs]);
                            localMusic.changeWatchPath(changeLogRef.current);
                            hideModal();
                        }}
                    >
                        {t("common.confirm")}
                    </div>
                </div>
            </div>
        </Base>
    );
}
