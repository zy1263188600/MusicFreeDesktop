// scripts/verify-fingerprint-common.ts
import { normalizeTag, buildTagKey, hammingSimilarity, groupByKey, decodeFingerprint } from "../src/shared/audio-fingerprint/common";
const assert = (c: boolean, m: string) => {
    if (!c) {
        console.error("FAIL:", m); process.exit(1);
    }
};
assert(normalizeTag("  Hello-World！ ") === "helloworld", "normalize");
assert(buildTagKey("夜曲", "周杰伦", "十一月的萧邦", 211) === buildTagKey("夜曲", "周杰伦", "十一月的萧邦", 212), "tag bucket");
assert(decodeFingerprint("1,2,3").length === 3, "decode string");
assert(decodeFingerprint([5, 6, 7]).join(",") === "5,6,7", "decode array passthrough");
assert(hammingSimilarity([1, 2], [1, 2]) === 1, "similarity identical");
const m = groupByKey(["a", "b", "a"]);
assert((m.get("a") ?? []).length === 2, "groupByKey");
console.log("verify-fingerprint-common PASS");
