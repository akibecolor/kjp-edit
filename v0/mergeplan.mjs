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
    // ⚠️ ラベルは衝突しうるので重複を潰す（`x/same/dup` と `y/same/dup` は
    //    どちらも `same/dup`。潰さないと batch に同じラベルが2回出る）。
    const labels = [...new Set(candidates.map(c => c.label))];
    const known = new Set(labels);

    // 衝突グラフ。辺は3種類に分ける:
    //   conflict = 検査済みで衝突する / clean = 検査済みで衝突しない / 未知 = 検査していない
    const conflictAdj = new Map(labels.map(l => [l, new Set()]));
    const cleanAdj = new Map(labels.map(l => [l, new Set()]));
    let tested = 0;
    for (const c of conflicts ?? []) {
        if (!known.has(c.a) || !known.has(c.b)) continue;
        if (c.a === c.b) continue;                 // 自己ペアは無意味
        // 🚨 **`clean === null`（不明）を衝突として扱わない。**
        //    以前は「true 以外は安全でない側」に置いていたので、submodule のように
        //    git が判定できないペアが**「衝突する」として提示**されていた（#2）。
        //    不明は「検査していない」と同じ扱いにする = ③ 不明に落ちる。
        //    こうすると `testedPairs` も正直な数になる。
        if (c.clean === true) {
            tested++;
            cleanAdj.get(c.a).add(c.b);
            cleanAdj.get(c.b).add(c.a);
        } else if (c.clean === false) {
            tested++;
            conflictAdj.get(c.a).add(c.b);
            conflictAdj.get(c.b).add(c.a);
        }
        // null は辺を張らない（検査済みにも数えない）
    }

    const totalPairs = labels.length * (labels.length - 1) / 2;
    const untestedPairs = Math.max(0, totalPairs - tested);

    // 次数が小さい順 → ahead が多い順 → 名前順（決定的にする）
    const aheadOf = new Map(candidates.map(c => [c.label, c.ahead ?? 0]));
    const order = [...labels].sort((x, y) =>
        conflictAdj.get(x).size - conflictAdj.get(y).size
        || (aheadOf.get(y) ?? 0) - (aheadOf.get(x) ?? 0)
        || x.localeCompare(y));

    // 🚨 batch に入れる条件は「**取得済みの全メンバーとのペアが検査済みかつ clean**」。
    //    以前は「衝突する辺が無い」だけで入れていたので、未検査のペアが
    //    同じ塊に同居し、実際に衝突する2本が「まとめて取り込める」と提示された
    //    （レビューで実測。12本の塊に衝突ペアが3組）。
    //    未検査の辺を持つものは unknown に落とす。
    const batch = [];
    const taken = [];
    const unknown = [];
    for (const l of order) {
        const conflictsWithTaken = taken.filter(t => conflictAdj.get(l).has(t));
        if (conflictsWithTaken.length) continue;   // 後で deferred に回す
        const untestedWithTaken = taken.filter(t => !cleanAdj.get(l).has(t));
        if (untestedWithTaken.length) {
            unknown.push({ label: l, untestedWith: untestedWithTaken.slice(0, 8) });
            continue;
        }
        batch.push(l);
        taken.push(l);
    }

    const inBatch = new Set(batch);
    const inUnknown = new Set(unknown.map(u => u.label));
    const deferred = order
        .filter(l => !inBatch.has(l) && !inUnknown.has(l))
        .map(l => {
            const all = [...conflictAdj.get(l)].sort();
            return {
                label: l,
                // ⚠️ 塊に入っている相手だけを挙げると、**deferred 同士の衝突が見えなくなる**。
                //    「a を入れて b と c を手当」と読めるが b と c も衝突する、という
                //    2周目の驚きが起きる（レビューで指摘）。両方を返す。
                conflictsWith: all,
                conflictsWithBatch: all.filter(o => inBatch.has(o)),
                conflictsWithDeferred: all.filter(o => !inBatch.has(o)),
            };
        });

    return { batch, deferred, unknown, untestedPairs, testedPairs: tested };
}

/**
 * 🚨 **提案のラベルを「git に渡す ref」に解決する（#60。10回目のレビュー / BLOCKING）。**
 *
 * `batch` の中身は `w.label`（**worktree のディレクトリ名**由来の表示名）であって
 * ref ではない。UI がそれをそのまま `branch` として `/api/v0/merge` に送っていたので:
 *
 * - ディレクトリ名がたまたま**別のブランチ名と一致**すると、
 *   **提案とは無関係なブランチが取り込まれる**（実測: ボタン「hotfix」＝
 *   worktree `hotfix/`（中身はブランチ `alpha`）を押すと、ブランチ `hotfix` が
 *   main に入り、200 と「✔ 取り込みました」が出た）。
 *   しかも門は送られた ref で `mergePreview` するので、
 *   **予測したペアと実行したペアが別物**になる = この経路の存在理由が消える
 * - ディレクトリ名≠ブランチ名という**普通の構成では常に 400**（`解決できない ref です`）
 *
 * 併せて、UI は payload に**存在しない** `w.shortBranch` を読んでいた
 * （サーバは `branch` に改名済み）。そのため取り込み先が常に一覧の先頭になり、
 * ヘッダが常に「(detached)」になり、自己取り込みの保護が一度も成立していなかった。
 *
 * ⚠️ **解決できないものは黙って落とさない。** `skipped` に理由付きで返し、
 *    UI がそれを出す（「省略したら必ず告知する」）。
 *
 * @param {{batch: string[]}} plan `planMerge()` の結果
 * @param {{name: string, branch: string|null, path: string}[]} worktrees payload の worktrees
 * @param {string|null} base 取り込み先のブランチ名（payload の `base`）
 * @returns {{target: object|null, entries: {label: string, branch: string}[],
 *            skipped: {label: string, why: string}[]}}
 */
export function mergeTargets(plan, worktrees, base) {
    const list = worktrees ?? [];
    // ⚠️ payload のフィールドは `branch`（`shortBranch` はサーバ内部の名前）
    const target = list.find(w => w.branch && w.branch === base) ?? list[0] ?? null;
    const entries = [];
    const skipped = [];
    for (const label of plan?.batch ?? []) {
        const w = list.find(x => x.name === label);
        if (!w) { skipped.push({ label, why: 'この worktree が一覧にありません' }); continue; }
        if (!w.branch) { skipped.push({ label, why: 'detached HEAD なので取り込めません' }); continue; }
        if (target && w.path === target.path) continue;   // 取り込み先自身（告知は不要）
        entries.push({ label, branch: w.branch });
    }
    return { target, entries, skipped };
}
