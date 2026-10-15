// scripts/verify-fingerprint-common.ts
import { normalizeTag, buildTagKey, hammingSimilarity, groupByKey, decodeFingerprint, detectVersionReason, buildVersionSignature } from "../src/shared/audio-fingerprint/common";
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
assert(detectVersionReason(
    { title: "秋风 (粤语版)", artist: "四熹丸子", localPath: "C:\\Music\\秋风 (粤语版)-四熹丸子.mp3" },
    { title: "秋风", artist: "四熹丸子", localPath: "C:\\Music\\秋风-四熹丸子.mp3" },
) !== null, "version: 粤语版");
assert(detectVersionReason(
    { title: "白玫瑰", artist: "陈奕迅", localPath: "C:\\Music\\白玫瑰-陈奕迅.mp3" },
    { title: "红玫瑰", artist: "陈奕迅", localPath: "C:\\Music\\红玫瑰-陈奕迅.mp3" },
) === null, "version: 白玫瑰/红玫瑰改手动标记");
assert(detectVersionReason(
    { title: "Where Did U Go (Album Version)", artist: "G.E.M. 邓紫棋", localPath: "C:\\Music\\Where Did U Go-G.E.M.mp3" },
    { title: "写不完的温柔", artist: "G.E.M. 邓紫棋", localPath: "C:\\Music\\写不完的温柔-G.E.M.mp3" },
) === "中英文标题", "version: 中英文");
assert(detectVersionReason(
    { title: "感应 (国语)", artist: "泳儿", localPath: "C:\\Music\\感应 (国语)-泳儿.mp3" },
    { title: "感应", artist: "泳儿", localPath: "C:\\Music\\感应-泳儿.mp3" },
) !== null, "version: 国语");
assert(detectVersionReason(
    { title: "夜曲", artist: "周杰伦", localPath: "C:\\Music\\夜曲.mp3" },
    { title: "夜曲", artist: "周杰伦", localPath: "C:\\Music\\夜曲-copy.mp3" },
) === null, "version: 真重复不过滤");
assert(buildVersionSignature(["b|1", "a|1"]) === buildVersionSignature(["a|1", "b|1"]), "version signature stable");
console.log("verify-fingerprint-common PASS");
