import "./index.scss";
import PathSettingItem from "../../components/PathSettingItem";
import useAppConfig from "@/hooks/useAppConfig";
import { getFingerprintCacheInfo, clearFingerprintCache } from "@shared/audio-fingerprint/renderer";
import duplicateScanStore from "@/renderer/components/Modal/templates/DuplicateMusic/store";
import { toast } from "react-toastify";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

function formatMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function LocalMusic() {
    const { t } = useTranslation();
    const cacheDir = useAppConfig("localMusic.fingerprintCacheDir");
    const [sizeBytes, setSizeBytes] = useState(0);

    useEffect(() => {
        getFingerprintCacheInfo().then((info) => setSizeBytes(info.sizeBytes));
    }, [cacheDir]);

    return (
        <div className="setting-view--local-music-container">
            <PathSettingItem
                keyPath="localMusic.fingerprintCacheDir"
                label={t("settings.local_music.fingerprint_cache_folder")}
            ></PathSettingItem>
            <div className="setting-row cache-row">
                <span>
                    {t("settings.local_music.fingerprint_cache_size")}: {formatMB(sizeBytes)}
                </span>
                <div
                    role="button"
                    data-type="normalButton"
                    onClick={async () => {
                        if (Object.keys(duplicateScanStore.getValue().scanning).some((k) => k.startsWith("audio"))) {
                            toast.info(t("local_music_page.duplicate_music_audio_busy"));
                            return;
                        }
                        await clearFingerprintCache();
                        const info = await getFingerprintCacheInfo();
                        setSizeBytes(info.sizeBytes);
                        toast.success(t("settings.local_music.cache_cleared"));
                    }}
                >
                    {t("settings.local_music.clear_fingerprint_cache")}
                </div>
            </div>
        </div>
    );
}
