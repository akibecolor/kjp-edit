// SPDX-License-Identifier: MIT
//
// 行単位の差分。**保存する前に「何が変わるか」を見せる**ためだけに使う。
//
// なぜクライアント側で計算するか: 編集中の内容はまだどこにも無い（作業ツリーにも
// git のオブジェクトにも入っていない）ので、`git diff` に渡す方法が
// 「先に書く」しかない。**書く前に見せる**という目的と矛盾するので、
// 手元で差分を作る。
//
// なぜ `app.html` の中ではなく外に置くか: **中に書いたロジックはテストできない**
// （`chatfilter` が「解釈できない行は出す」という宣言を破っていたのに
//  気付けなかったのと同じ理由。CLAUDE.md）。ブラウザとユニットテストが同じコードを読む。
//
// ⚠️ **上限を必ず持つ。** LCS は O(n×m) なので、512KB のファイルを丸ごと
//    突き合わせるとブラウザが固まる（描画が総文字数に対して二次だった #3 と同型の事故）。
//    上限を超えたら「行の対応は取っていない」と**告知して**まとめて出す。
//    黙って上位N件に絞ると「全部見た」と読める。

/** DP 表のセル数の上限。250,000 セル = Uint32Array で 1MB。 */
export const MAX_DIFF_CELLS = 250_000;

/** 変更のまわりに何行の文脈を出すか。 */
export const DEFAULT_CONTEXT = 3;

/**
 * 末尾の空要素を落として行に割る。
 * ⚠️ これは「末尾に改行があるか」を落とす。呼び出し側が
 *    `trailingNewlineChanged` で別に告知する（見えない変更を作らない）。
 */
function splitLines(text) {
    const lines = String(text ?? '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * LCS で最短の編集列を作る。返すのは `{t: ' '|'-'|'+', s}` の配列。
 *
 * ⚠️ `Uint32Array` の1次元表を使う（2次元配列は要素ごとにオブジェクトを作るので
 *    上限まで使うと GC が効かない）。
 */
function lcsOps(a, b) {
    const n = a.length, m = b.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = a[i] === b[j]
                ? dp[(i + 1) * w + (j + 1)] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
        }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ t: '-', s: a[i] }); i++; }
        else { ops.push({ t: '+', s: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', s: a[i++] });
    while (j < m) ops.push({ t: '+', s: b[j++] });
    return ops;
}

/**
 * 変更のある塊を文脈つきで unified diff 風の行にする。
 * @param {{t: string, s: string}[]} ops
 */
function hunkify(ops, context) {
    const interesting = ops.map(o => o.t !== ' ');
    const keep = new Array(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
        if (!interesting[i]) continue;
        for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
            keep[k] = true;
        }
    }
    const lines = [];
    let oldNo = 1, newNo = 1;
    let i = 0;
    while (i < ops.length) {
        if (!keep[i]) {
            if (ops[i].t !== '+') oldNo++;
            if (ops[i].t !== '-') newNo++;
            i++;
            continue;
        }
        // 塊の範囲を決める
        const start = i;
        const oldStart = oldNo, newStart = newNo;
        let oldLen = 0, newLen = 0;
        while (i < ops.length && keep[i]) {
            if (ops[i].t !== '+') { oldLen++; oldNo++; }
            if (ops[i].t !== '-') { newLen++; newNo++; }
            i++;
        }
        lines.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen}`
            + ` +${newLen ? newStart : newStart - 1},${newLen} @@`);
        for (let k = start; k < i; k++) lines.push(`${ops[k].t}${ops[k].s}`);
    }
    return lines;
}

/**
 * 2つのテキストの行差分。
 *
 * @param {string} a 変更前
 * @param {string} b 変更後
 * @returns {{lines: string[], added: number, removed: number, approx: boolean,
 *            why: (string|null), trailingNewlineChanged: boolean}}
 *   `lines` は unified diff 風（`renderDiff()` がそのまま色付けできる形）。
 *   `approx` が真なら**行の対応は取っていない**（`why` に理由を入れる）。
 */
export function diffLines(a, b, { context = DEFAULT_CONTEXT, maxCells = MAX_DIFF_CELLS } = {}) {
    const A = splitLines(a), B = splitLines(b);
    // 共通の先頭・末尾を落として LCS の対象を小さくする（編集は局所的なので効く）
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre
        && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const aMid = A.slice(pre, A.length - suf);
    const bMid = B.slice(pre, B.length - suf);

    let mid, approx = false, why = null;
    if ((aMid.length + 1) * (bMid.length + 1) > maxCells) {
        approx = true;
        why = `変更範囲が大きいので行の対応は取っていません（削除 ${aMid.length} 行 /`
            + ` 追加 ${bMid.length} 行をまとめて出しています）`;
        mid = [...aMid.map(s => ({ t: '-', s })), ...bMid.map(s => ({ t: '+', s }))];
    } else {
        mid = lcsOps(aMid, bMid);
    }
    const ops = [
        ...A.slice(0, pre).map(s => ({ t: ' ', s })),
        ...mid,
        ...A.slice(A.length - suf).map(s => ({ t: ' ', s })),
    ];
    const added = ops.filter(o => o.t === '+').length;
    const removed = ops.filter(o => o.t === '-').length;
    // 🚨 **末尾の改行の有無は行の配列に出ない。** ここで告知しないと
    //    「差分なし」と表示したまま保存でバイト列が変わる（見えない変更になる）。
    const endsA = String(a ?? '').endsWith('\n');
    const endsB = String(b ?? '').endsWith('\n');
    return {
        lines: hunkify(ops, context),
        added,
        removed,
        approx,
        why,
        trailingNewlineChanged: endsA !== endsB && (A.length > 0 || B.length > 0),
    };
}
