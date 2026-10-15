import {
    getUserPreferenceIDB,
    setUserPreferenceIDB,
} from "@/renderer/utils/user-perference";
import Base from "../Base";
import "./index.scss";
import { hideModal } from "../..";
import { useEffect, useRef, useState } from "react";
import Condition from "@/renderer/components/Condition";
import Empty from "@/renderer/components/Empty";
import SvgAsset from "@/renderer/components/SvgAsset";
import Checkbox from "@/renderer/components/Checkbox";
import localMusic from "@/renderer/core/local-music";
import { useTranslation } from "react-i18next";
import { dialogUtil } from "@shared/utils/renderer";
import { toast } from "react-toastify";


export default function WatchLocalDir() {
    // 全部的文件夹
    const [localDirs, setLocalDirs] = useState<string[]>([]);
    // 选中的文件夹
    const [checkedDirs, setCheckedDirs] = useState(new Set<string>());
    const [rescanning, setRescanning] = useState(false);
    const changeLogRef = useRef(new Map<string, "add" | "delete">()); // key: path; value: op
    const { t } = useTranslation();

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
                                onClick={async () => {
                                    if (rescanning) return;
                                    const dirs = [...checkedDirs];
                                    if (!dirs.length) {
                                        toast.info("请先勾选要刷新的文件夹");
                                        return;
                                    }
                                    setRescanning(true);
                                    try {
                                        const result = await localMusic.rescanSelectedDirs(dirs);
                                        toast.success(`刷新完成：扫描 ${result.scanned} 首，新增 ${result.added} 首，清理 ${result.removed} 首`);
                                    } catch {
                                        toast.error("刷新失败");
                                    } finally {
                                        setRescanning(false);
                                    }
                                }}
                            >
                                {rescanning ? "刷新中..." : "刷新"}
                            </div>
                        </div>
                    </div>
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

                                return (
                                    <div
                                        className="row-container"
                                        key={item}
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
                                        <Checkbox
                                            checked={isChecked}
                                            style={{
                                                color: isChecked ? "var(--primaryColor)" : undefined,
                                            }}
                                        ></Checkbox>
                                        <div className="title">{item}</div>
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
                                );
                            })}
                        </Condition>
                    </div>
                </div>
                <div className="footer-options">
                    <div
                        role="button"
                        data-type="primaryButton"
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
