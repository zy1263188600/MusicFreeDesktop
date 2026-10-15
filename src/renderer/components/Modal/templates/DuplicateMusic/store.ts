import Store from "@/common/store";
import type { DuplicateGroup, ScanMode } from "./scan";

export interface FingerprintScanProgress {
    done: number;
    total: number;
    mode: ScanMode;
    phase: "compute" | "compare";
}

interface DuplicateScanState {
    /** 结果缓存：key=模式（音频带阈值），随软件退出释放 */
    groupsByKey: Record<string, DuplicateGroup[]>;
    /** 勾选缓存：与结果同 key */
    checkedByKey: Record<string, string[]>;
    /** 进行中的扫描：key->进度，关弹窗不中断，随软件退出释放 */
    scanning: Record<string, FingerprintScanProgress>;
}

const duplicateScanStore = new Store<DuplicateScanState>({
    groupsByKey: {},
    checkedByKey: {},
    scanning: {},
});

export function setScanProgress(key: string, prog: FingerprintScanProgress | null): void {
    duplicateScanStore.setValue((prev) => {
        const scanning = { ...prev.scanning };
        if (prog) scanning[key] = prog;
        else delete scanning[key];
        return { ...prev, scanning };
    });
}

export function setScanGroups(key: string, groups: DuplicateGroup[]): void {
    duplicateScanStore.setValue((prev) => ({
        ...prev,
        groupsByKey: { ...prev.groupsByKey, [key]: groups },
    }));
}

export function setScanChecked(key: string, keys: string[]): void {
    duplicateScanStore.setValue((prev) => ({
        ...prev,
        checkedByKey: { ...prev.checkedByKey, [key]: keys },
    }));
}

/** 清空全部结果与勾选（指纹重算/清库后调用，结果已失效） */
export function clearScanResults(): void {
    duplicateScanStore.setValue((prev) => ({
        ...prev,
        groupsByKey: {},
        checkedByKey: {},
    }));
}

/** 被用户取消的扫描 key：只停掉排队与落盘，关弹窗不写入（退出软件随进程释放） */
const cancelledScanKeys = new Set<string>();

export function cancelScan(key: string): void {
    cancelledScanKeys.add(key);
}

export function isScanCancelled(key: string): boolean {
    return cancelledScanKeys.has(key);
}

export function clearScanCancelled(key: string): void {
    cancelledScanKeys.delete(key);
}

export default duplicateScanStore;
