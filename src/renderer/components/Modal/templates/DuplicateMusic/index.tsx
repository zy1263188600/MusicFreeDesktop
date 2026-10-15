import { useEffect, useState } from "react";
import Base from "../Base";
import "./index.scss";
import { toast } from "react-toastify";
import { useTranslation } from "react-i18next";
import localMusicListStore from "@/renderer/core/local-music/store";
import trackPlayer from "@/renderer/core/track-player";
import { shellUtil } from "@shared/utils/renderer";
import Checkbox from "@/renderer/components/Checkbox";
import Empty from "@/renderer/components/Empty";
import { checkFingerprintBinary, clearFingerprintCache, getFingerprintCacheInfo, pruneFingerprintCache } from "@shared/audio-fingerprint/renderer";
import { runDuplicateScan, ScanMode } from "./scan";
import duplicateScanStore, { cancelScan, clearScanResults, isScanCancelled, clearScanCancelled, setScanChecked, setScanGroups, setScanProgress } from "./store";
import { showModal, hideModal } from "../..";
import { secondsToDuration } from "@/common/time-util";

const THRESHOLDS = { strict: 0.95, standard: 0.88, loose: 0.8 } as const;

const MODE_LABELS: Record<ScanMode, string> = {
    filename: "duplicate_music_mode_filename",
    tag: "duplicate_music_mode_tag",
    exact: "duplicate_music_mode_exact",
    audio: "duplicate_music_mode_audio",
};

const LEVEL_LABELS: Record<keyof typeof THRESHOLDS, string> = {
    strict: "duplicate_music_level_strict",
    standard: "duplicate_music_level_standard",
    loose: "duplicate_music_level_loose",
};

function formatFileSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function DuplicateMusic() {
    const { t } = useTranslation();
    const [mode, setMode] = useState<ScanMode>("audio");
    const [level, setLevel] = useState<keyof typeof THRESHOLDS>("standard");
    const [binError, setBinError] = useState<string | null>(null);
    const defSize = "0.0KB";
    const [cacheSize, setCacheSize] = useState(defSize);
    const [diskCount, setDiskCount] = useState(0);
    // 非音频模式的 key 与阈值无关（阈值只影响音纹分组），避免同一切档建多份缓存
    const keyFor = (m: ScanMode, lv: keyof typeof THRESHOLDS) => (m === "audio" ? `${m}|${THRESHOLDS[lv]}` : m);
    // 会话级状态：结果/勾选/进度在 store 里，关弹窗不丢，随软件退出释放
    const scanState = duplicateScanStore.useValue();
    const currentKey = keyFor(mode, level);
    const groups = scanState.groupsByKey[currentKey] ?? [];
    const checked = new Set(scanState.checkedByKey[currentKey] ?? []);
    const setCheckedKeys = (next: Set<string>) => setScanChecked(currentKey, [...next]);
    const refreshCacheSize = async () => {
        try {
            const info = await getFingerprintCacheInfo();
            setCacheSize(info.sizeBytes ? formatFileSize(info.sizeBytes) : defSize);
            setDiskCount(info.count ?? 0);
        } catch {
            // 大小读不到只影响展示
        }
    };    // 音纹三档共用一个扫描槽：只要有音频任务在跑，就显示它（不分档位）
    const audioKey = Object.keys(scanState.scanning).find((k) => k.startsWith("audio"));
    const audioProg = audioKey ? scanState.scanning[audioKey] : undefined;
    const mainProgKey = mode === "audio" ? audioKey : currentKey;
    const mainProg = mode === "audio" ? audioProg : scanState.scanning[currentKey];

    useEffect(() => {
        refreshCacheSize();
    }, []);

    // 非音频模式：纯对比（hash/标签/文件名不需要指纹步骤）
    const startCompare = async () => {
        const key = currentKey;
        // 同一个 tab 的对比正在跑就不重复启动；其他 tab 的可以并行
        if (key in scanState.scanning) return;
        clearScanCancelled(key);
        setBinError(null);
        setScanProgress(key, { done: 0, total: 0, mode, phase: "compare" });
        try {
            const list = localMusicListStore.getValue();
            setScanProgress(key, { done: 0, total: list.length, mode, phase: "compare" });
            const { groups: g } = await runDuplicateScan(
                list.map((it) => ({ key: `${it.platform}+${it.id}`, title: it.title, artist: it.artist, album: it.album, duration: it.duration, localPath: it.$$localPath })),
                mode,
                THRESHOLDS[level],
                (done, total) => {
                    setScanProgress(key, { done, total, mode, phase: "compare" });
                },
                () => isScanCancelled(key),
            );
            if (!isScanCancelled(key)) setScanGroups(key, g);
        } finally {
            clearScanCancelled(key);
            setScanProgress(key, null);
            refreshCacheSize();
        }
    };

    // 音频模式分两步：计算音纹（耗时，只写磁盘缓存）与对比（分组展示）
    // kind: compare=对比分组；compute-new=只算新增；compute-all=清空后全量重算
    const startAudioTask = async (kind: "compare" | "compute-new" | "compute-all") => {
        // 音纹单槽：任何音频任务（含计算）在跑都不再启动
        if (Object.keys(duplicateScanStore.getValue().scanning).some((k) => k.startsWith("audio"))) {
            toast.info(t("local_music_page.duplicate_music_audio_busy"));
            return;
        }
        setBinError(null);
        const bin = await checkFingerprintBinary();
        if (!bin.ok) {
            setBinError(bin.error ?? "fpcalc missing");
            return;
        }
        const list = localMusicListStore.getValue();
        const before = (await getFingerprintCacheInfo().catch(() => ({ count: 0 }))).count ?? 0;
        let removed = 0;
        if (kind === "compute-all") {
            await clearFingerprintCache();
            clearScanResults();
        }
        if (kind === "compute-new") {
            // 先清理库里已没有的失效条目，再只算新增
            removed = (await pruneFingerprintCache(list.map((it) => it.$$localPath)).catch(() => ({ removed: 0 }))).removed ?? 0;
        } else if (kind === "compute-all") {
            removed = before;
        }
        const runKey = kind === "compare" ? currentKey : "audio-compute";
        clearScanCancelled(runKey);
        setScanProgress(runKey, {
            done: 0,
            total: list.length,
            mode: "audio",
            phase: kind === "compare" ? "compare" : "compute",
        });
        try {
            const { groups: g, stats } = await runDuplicateScan(
                list.map((it) => ({ key: `${it.platform}+${it.id}`, title: it.title, artist: it.artist, album: it.album, duration: it.duration, localPath: it.$$localPath })),
                "audio",
                THRESHOLDS[level],
                (done, total) => {
                    setScanProgress(runKey, {
                        done,
                        total,
                        mode: "audio",
                        phase: kind === "compare" ? "compare" : "compute",
                    });
                },
                () => isScanCancelled(runKey),
            );
            if (isScanCancelled(runKey)) return;
            if (kind === "compare") {
                setScanGroups(runKey, g);
            } else {
                const after = (await getFingerprintCacheInfo().catch(() => ({ count: 0 }))).count ?? 0;
                toast.success(t("local_music_page.duplicate_music_compute_report", {
                    computed: stats.computed,
                    hit: stats.hit,
                    added: Math.max(0, after - (before - removed)),
                    removed,
                }));
            }
        } finally {
            clearScanCancelled(runKey);
            setScanProgress(runKey, null);
            refreshCacheSize();
        }
    };

    return (
        <Base defaultClose>
            <div className="modal--duplicate-music-container shadow backdrop-color">
                <Base.Header>{t("local_music_page.duplicate_music")}</Base.Header>
                <div className="toolbar">
                    <div className="tabs-block">
                        <div className="tab-list-container">
                            {(Object.keys(MODE_LABELS) as ScanMode[]).map((m) => {
                                const tabKey = m === "audio" ? audioKey : m;
                                const prog = tabKey ? scanState.scanning[tabKey] : undefined;
                                const pct = prog && prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
                                return (
                                    <div
                                        key={m}
                                        role="button"
                                        className={`tab-list-item${prog ? " has-progress" : ""}`}
                                        data-headlessui-state={mode === m ? "selected" : null}
                                        onClick={() => setMode(m)}
                                    >
                                        {t(`local_music_page.${MODE_LABELS[m]}`)}
                                        {prog && <span className="tab-progress" style={{ width: `${pct}%` }} title={`${t(`local_music_page.${prog.phase === "compute" ? "duplicate_music_phase_compute" : "duplicate_music_phase_compare"}`)} ${prog.done}/${prog.total}`} />}
                                        {prog && tabKey && <span className="tab-cancel" role="button" title={t("common.cancel")} onClick={(e) => {
                                            e.stopPropagation(); cancelScan(tabKey); 
                                        }}>×</span>}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    {mode !== "audio" && (
                        <div role="button" data-type="primaryButton" onClick={startCompare}>{t(currentKey in scanState.groupsByKey ? "local_music_page.duplicate_music_recompare" : "local_music_page.duplicate_music_compare")}</div>
                    )}
                </div>
                {binError && <div className="error">{binError}</div>}
                {mainProg && mainProgKey && (
                    <div className="progress">
                        <div className="progress-bar"><span style={{ width: `${mainProg.total ? Math.round((mainProg.done / mainProg.total) * 100) : 0}%` }} /></div>
                        <span>{t(`local_music_page.${mainProg.phase === "compute" ? "duplicate_music_phase_compute" : "duplicate_music_phase_compare"}`)} {mainProg.done}/{mainProg.total}</span>
                        <span className="cancel-progress" role="button" onClick={() => mainProgKey && cancelScan(mainProgKey)}>{t("common.cancel")}</span>
                    </div>
                )}
                <div className="assist">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            const keep = new Set(groups.map((g) => g.ids[0]));
                            const next = new Set<string>();
                            groups.forEach((g) => {
                                g.ids.forEach((id) => {
                                    if (!keep.has(id)) next.add(id);
                                });
                            });
                            setCheckedKeys(next);
                        }}
                    >每组保留第一首</div>
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            const next = new Set<string>();
                            groups.forEach((g) => {
                                g.ids.forEach((id) => next.add(id));
                            });
                            setCheckedKeys(next);
                        }}
                    >全选</div>
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => setCheckedKeys(new Set())}
                    >清空</div>
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            const targets = groups.flatMap((g) => g.items).filter((it) => checked.has(it.key));
                            if (!targets.length) return;
                            const preview = targets.slice(0, 5).map((it) => (it.localPath.split(/[/\\]/).pop() ?? it.localPath)).join("、");
                            showModal("Reconfirm", {
                                title: t("local_music_page.duplicate_music"),
                                content: `确定将 ${targets.length} 首从音乐库移除吗？磁盘文件将保留。\n${preview}${targets.length > 5 ? `…等 ${targets.length} 个文件` : ""}`,
                                async onConfirm() {
                                    hideModal();
                                    const keys = new Set(targets.map((it) => it.key));
                                    const { default: musicSheetDB } = await import("@renderer/core/db/music-sheet-db");
                                    const full = localMusicListStore.getValue().filter((x) => keys.has(`${x.platform}+${x.id}`));
                                    await musicSheetDB.localMusicStore.bulkDelete(full.map((x) => [x.platform, x.id]) as any);
                                    localMusicListStore.setValue(localMusicListStore.getValue().filter((x) => !keys.has(`${x.platform}+${x.id}`)));
                                    setScanChecked(currentKey, []);
                                    const prevGroups = duplicateScanStore.getValue().groupsByKey[currentKey] ?? [];
                                    setScanGroups(currentKey, prevGroups.map((g) => ({ ...g, ids: g.items.filter((it) => !keys.has(it.key)).map((it) => it.key), items: g.items.filter((it) => !keys.has(it.key)) })).filter((g) => g.items.length > 1));
                                },
                            });
                        }}
                    >仅从音乐库移除</div>
                    <div
                        role="button"
                        data-type="dangerButton"
                        onClick={() => {
                            const targets = groups.flatMap((g) => g.items).filter((it) => checked.has(it.key));
                            if (!targets.length) return;
                            const preview = targets.slice(0, 5).map((it) => (it.localPath.split(/[/\\]/).pop() ?? it.localPath)).join("、");
                            showModal("Reconfirm", {
                                title: t("local_music_page.duplicate_music"),
                                content: `确定彻底删除 ${targets.length} 个文件吗？磁盘文件将被删除且不可恢复。\n${preview}${targets.length > 5 ? `…等 ${targets.length} 个文件` : ""}`,
                                async onConfirm() {
                                    hideModal();
                                    const { deleteLocalFiles } = await import("@shared/audio-fingerprint/renderer");
                                    const r = await deleteLocalFiles(targets.map((it) => it.localPath));
                                    if (r.failed.length) toast.error(`有 ${r.failed.length} 个文件删除失败`);
                                    const okPaths = new Set(r.deleted);
                                    const okKeys = new Set(targets.filter((it) => okPaths.has(it.localPath)).map((it) => it.key));
                                    const { default: musicSheetDB } = await import("@renderer/core/db/music-sheet-db");
                                    const full = localMusicListStore.getValue().filter((x) => okKeys.has(`${x.platform}+${x.id}`));
                                    await musicSheetDB.localMusicStore.bulkDelete(full.map((x) => [x.platform, x.id]) as any);
                                    localMusicListStore.setValue(localMusicListStore.getValue().filter((x) => !okKeys.has(`${x.platform}+${x.id}`)));
                                    setScanChecked(currentKey, []);
                                    const prevGroups = duplicateScanStore.getValue().groupsByKey[currentKey] ?? [];
                                    setScanGroups(currentKey, prevGroups.map((g) => ({ ...g, ids: g.items.filter((it) => !okKeys.has(it.key)).map((it) => it.key), items: g.items.filter((it) => !okKeys.has(it.key)) })).filter((g) => g.items.length > 1));
                                },
                            });
                        }}
                    >彻底删除选中文件</div>
                </div>
                {mode === "audio" && (
                    <div className="audio-row">
                        {diskCount > 0 ? (
                            <>
                                <div role="button" data-type="primaryButton" onClick={() => startAudioTask("compute-new")}>{t("local_music_page.duplicate_music_compute_new")}</div>
                                <div role="button" data-type="normalButton" onClick={() => startAudioTask("compute-all")}>{t("local_music_page.duplicate_music_compute_all")}</div>
                            </>
                        ) : (
                            <div role="button" data-type="primaryButton" onClick={() => startAudioTask("compute-new")}>{t("local_music_page.duplicate_music_compute")}</div>
                        )}
                        <span className="level-inline">
                            <span className="level-label">相似度</span>
                            {(Object.keys(LEVEL_LABELS) as Array<keyof typeof THRESHOLDS>).map((lv) => (
                                <span
                                    key={lv}
                                    role="button"
                                    className={`level-item${level === lv ? " active" : ""}`}
                                    onClick={() => setLevel(lv)}
                                >
                                    {t(`local_music_page.${LEVEL_LABELS[lv]}`)}
                                </span>
                            ))}
                        </span>
                        <div role="button" data-type="primaryButton" onClick={() => startAudioTask("compare")}>{t(currentKey in scanState.groupsByKey ? "local_music_page.duplicate_music_recompare" : "local_music_page.duplicate_music_compare")}</div>
                        <div
                            role="button"
                            data-type="normalButton"
                            onClick={async () => {
                                if (Object.keys(duplicateScanStore.getValue().scanning).some((k) => k.startsWith("audio"))) {
                                    toast.info(t("local_music_page.duplicate_music_audio_busy"));
                                    return;
                                }
                                await clearFingerprintCache();
                                clearScanResults();
                                await refreshCacheSize();
                                toast.success(t("local_music_page.duplicate_music_cache_cleared"));
                            }}
                        >{t("local_music_page.duplicate_music_clear_cache")}</div>
                        <span className="cache-size">{t("settings.local_music.fingerprint_cache_size")}: {cacheSize}</span>
                    </div>
                )}
                <div className="groups">
                    {!mainProg && groups.length === 0 ? (
                        <Empty
                            style={{
                                minHeight: "200px",
                            }}
                        ></Empty>
                    ) : (
                        groups.map((g, gi) => (
                            <div key={gi} className="group">
                                <div className="group-header">组{gi + 1} · {g.items.length}首</div>
                                {g.items.map((it) => (
                                    <div key={it.key} role="button" className={`row${checked.has(it.key) ? " selected" : ""}`} onClick={() => {
                                        const next = new Set(checked);
                                        if (next.has(it.key)) next.delete(it.key);
                                        else next.add(it.key);
                                        setCheckedKeys(next);
                                    }}>
                                        <Checkbox checked={checked.has(it.key)}></Checkbox>
                                        <span className="titles">
                                            <span className="title-row">
                                                <span className="title">{it.title} - {it.artist}</span>
                                                <span className="meta">{it.duration !== undefined ? secondsToDuration(Math.round(it.duration)) : ""}</span>
                                            </span>
                                            <span className="file-row">
                                                <span className="file-name">{it.localPath.split(/[/\\]/).pop() ?? it.localPath}</span>
                                                <span className="meta">{it.size !== undefined ? formatFileSize(it.size) : ""}</span>
                                            </span>
                                        </span>
                                        <span
                                            className="action"
                                            role="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const full = localMusicListStore.getValue().find((x) => `${x.platform}+${x.id}` === it.key);
                                                if (full) trackPlayer.playMusicWithReplaceQueue([full], full);
                                            }}
                                        >试听</span>
                                        <span className="action" role="button" onClick={(e) => {
                                            e.stopPropagation();
                                            shellUtil.showItemInFolder(it.localPath);
                                        }}>在文件中打开</span>
                                    </div>
                                ))}
                            </div>
                        ))
                    )}
                </div>
                <div className="footer-options">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            // 只关弹窗：扫描在后台继续，结果进会话缓存，随软件退出释放
                            hideModal();
                        }}
                    >{t("common.close")}</div>
                </div>
            </div>
        </Base>
    );
}
