export function normalizeTag(s: string): string {
    return (s ?? "")
        .toLowerCase()
        .replace(/[\s\-_、。．，．·•‐‑‒–—―…,.!?！？；;：:"'“”‘’（）()【】[\]{}<>《》・、]/g, "")
        .replace(/\u3000/g, "")
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
    if (typeof fp === "string" && !fp.trim()) return [];
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
        while (x) {
            bits += x & 1; x >>>= 1;
        }
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
