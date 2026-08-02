// SPDX-License-Identifier: MIT
//
// 取り込み順序の提案。**追加の git 呼び出しは0。AI も使わない。**
// 既に計算済みの衝突ペア（mergePreview の結果）だけを入力にする純関数。
//
// やっていること: 衝突グラフの独立集合を貪欲に取る。
//   衝突しないブランチ同士は**どの順でも**取り込めるので、
//   まずその塊を出し、残りを「手当が必要」として衝突相手つきで並べる。
//
// ⚠️ これは**仮説**であって保証ではない。理由が2つある:
//   1. ペア単位で衝突しないことは、まとめて衝突しないことを意味しない
//      （3者間で初めて起きる衝突がある）
//   2. 検査していないペアがある。候補はファイルが重なるペアだけなので、
//      rename と delete の組み合わせは別パスでも衝突しうる
//   だから戻り値に untestedPairs を入れて、UI 側で断定しないようにする。
//
// 独立集合の最大化は一般には NP 困難だが、worktree は数本〜数十本なので
// 次数の小さい順に取る貪欲で十分。**説明できる順序**であることを優先する
// （なぜこの順なのかが読めないと判断材料にならない）。

/**
 * @param {{label: string, ahead: number}[]} candidates 取り込む候補
 * @param {{a: string, b: string, clean: boolean}[]} conflicts 検査済みのペア
 * @returns {{batch: string[], deferred: {label: string, conflictsWith: string[]}[],
 *            untestedPairs: number, testedPairs: number}}
 */
export function planMerge(candidates, conflicts) {
    const labels = candidates.map(c => c.label);
    const known = new Set(labels);

    // 衝突グラフ（検査済みで clean=false のペアだけが辺）
    const adj = new Map(labels.map(l => [l, new Set()]));
    let tested = 0;
    for (const c of conflicts ?? []) {
        if (!known.has(c.a) || !known.has(c.b)) continue;
        tested++;
        if (c.clean) continue;
        adj.get(c.a).add(c.b);
        adj.get(c.b).add(c.a);
    }

    // 検査していないペアの数。断定しないための材料
    const totalPairs = labels.length * (labels.length - 1) / 2;
    const untestedPairs = Math.max(0, totalPairs - tested);

    // 次数が小さい順 → ahead が多い順 → 名前順（決定的にする）
    const aheadOf = new Map(candidates.map(c => [c.label, c.ahead ?? 0]));
    const order = [...labels].sort((x, y) =>
        adj.get(x).size - adj.get(y).size
        || (aheadOf.get(y) ?? 0) - (aheadOf.get(x) ?? 0)
        || x.localeCompare(y));

    const batch = [];
    const taken = new Set();
    for (const l of order) {
        // 既に取ったものと衝突しないなら同じ塊に入れられる
        let ok = true;
        for (const t of taken) if (adj.get(l).has(t)) { ok = false; break; }
        if (ok) { batch.push(l); taken.add(l); }
    }

    const deferred = order
        .filter(l => !taken.has(l))
        .map(l => ({
            label: l,
            // 衝突相手のうち、先に取り込む塊に入っているものを挙げる
            conflictsWith: [...adj.get(l)].filter(o => taken.has(o)).sort(),
        }));

    return { batch, deferred, untestedPairs, testedPairs: tested };
}
