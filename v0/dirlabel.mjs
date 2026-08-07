// SPDX-License-Identifier: MIT
//
// パスの集合を「画面で見分けられる短い文字」にする。
// ブラウザ（`app.html`）とサーバ（`server.mjs`）と unit テストで共有する
// （`app.html` の中に置くとテストできない、の規則）。
//
// 🚨 **なぜ要るか（#50）。** 監視盤の行見出しは basename だけだった。
//    エージェントを並列に回すと `.../a/wt-main` と `.../b/wt-main` のように
//    **basename が同じ worktree** が並ぶ（そういう置き方をするのが普通）。
//    見分けられないまま各行に標準入力の欄があるので、
//    **別のエージェントに文字が入る**（観測ツールが誤操作を誘発する最悪の形）。

/** パスを区切り文字で分ける（git は Windows でも `/` を返し、`path.join` は `\`） */
const parts = p => String(p ?? '').split(/[\\/]/).filter(Boolean);

/**
 * 衝突しない**最短**のラベルを作る（末尾から必要な分だけ親を足す）。
 *
 * ⚠️ フルパスに落とすのは最後の手段。スマホの狭い列ではフルパスは読めない
 *    （`text-overflow: ellipsis` で先頭だけ見えて、結局区別できない）。
 * ⚠️ **入力と同じ順序・同じ長さの配列を返す**（呼び出し側が index で対応させる）。
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function uniqueLabels(paths) {
    const list = Array.isArray(paths) ? paths : [];
    const segs = list.map(parts);
    // 段数は最大でパスの深さ。1段ずつ増やして、衝突しているものだけ伸ばす
    const depth = segs.map(() => 1);
    const label = i => (segs[i].length ? segs[i].slice(-depth[i]).join('/') : String(list[i] ?? ''));
    const maxDepth = Math.max(1, ...segs.map(s => s.length));
    for (let round = 0; round < maxDepth; round++) {
        const count = new Map();
        for (let i = 0; i < list.length; i++) {
            const l = label(i);
            count.set(l, (count.get(l) ?? 0) + 1);
        }
        let grew = false;
        for (let i = 0; i < list.length; i++) {
            if ((count.get(label(i)) ?? 0) <= 1) continue;
            // まだ足せる親があるなら1段伸ばす
            if (depth[i] < segs[i].length) { depth[i]++; grew = true; }
        }
        if (!grew) break;
    }
    return list.map((p, i) => label(i) || String(p ?? ''));
}

/**
 * basename で衝突したら**フルパス**を出す（選択リスト用）。
 *
 * ⚠️ 監視盤（`uniqueLabels`）と使い分ける。リポジトリの選択は数本しか無く、
 *    「どのリポジトリか」を取り違えると読む対象そのものが変わるので、
 *    曖昧さを完全に消す方（フルパス）に倒す。
 */
export function collisionFullLabels(paths) {
    const list = Array.isArray(paths) ? paths : [];
    const base = list.map(p => parts(p).pop() ?? String(p ?? ''));
    const count = new Map();
    for (const b of base) count.set(b, (count.get(b) ?? 0) + 1);
    return base.map((b, i) => ((count.get(b) ?? 0) > 1 ? list[i] : b));
}
