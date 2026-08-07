// SPDX-License-Identifier: MIT
//
// `node --test` の出力を読む**純関数**。
//
// 🚨 **なぜ module に出したか（#52）。** 要約は verify.mjs の中にあり、
//    トップレベル await でその場から検証が走り始めるので **import できず、
//    テストも変異も1件も掛かっていなかった**。「skipped を数えない」という
//    バグが4か月そこにあっても誰も落ちない状態だった。
//    要約は「測っていないものを緑と読ませない」ための最後の砦なので、
//    ここだけは検査できる形にしておく。

/**
 * 失敗の詳細に出す行を選ぶ。
 *
 * ⚠️ 打ち切り（`fromEnd`）のときは**末尾**を出す。先頭は起動時の案内で埋まり、
 *    「何を待っていたか」が入らない（macOS の layout でこれに遭った）。
 */
export function detailLines(output, n, fromEnd) {
    const lines = String(output ?? '').split('\n').filter(l => l.trim());
    return fromEnd ? lines.slice(-n) : lines.slice(0, n);
}

/** node --test の出力から失敗だけを抜き出して短くする */
export function summarizeTests(output) {
    const lines = output.split('\n');
    // node --test は ✖ を2回出す（インラインと末尾の "failing tests:" 要約）。
    // 名前で重複排除し、原因が取れている方を残す。
    const byName = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^✖\s+(.+?)\s+\(/);
        if (!m) continue;
        const cause = lines.slice(i + 1, i + 6)
            .map(l => l.trim())
            .find(l => /Error|Assertion|expected|actual|!==/.test(l)) ?? '';
        const prev = byName.get(m[1]);
        if (!prev || (!prev.cause && cause)) byName.set(m[1], { name: m[1], cause });
    }
    const failing = [...byName.values()];
    const counts = {};
    // 🚨 **skipped と todo も数える（#52）。** 出さないと
    //    「プラットフォームで飛ばした検査」が緑と区別できない。
    for (const key of ['pass', 'fail', 'skipped', 'todo']) {
        const m = output.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'));
        counts[key] = m ? Number(m[1]) : 0;
    }
    // どれが飛ばされたかも持つ（件数だけだと「何が測られていない」が分からない）。
    //    node --test は skip を `﹣ 名前 (Nms) # 理由` の形で出す。
    const skippedNames = lines
        .map(l => /^\s*﹣\s+(.+?)\s+\(/.exec(l))
        .filter(Boolean)
        .map(m => m[1]);
    return { failing, skippedNames, ...counts };
}

/**
 * テスト1本ぶんの失敗表示を作る。
 *
 * ⚠️ **要約が取れなかったときは生の末尾を出す。** `node --test` は
 * クラッシュや SIGKILL では `ℹ pass N` を出さないので、そのまま整形すると
 * 「smoke (0 pass, 0 fail)」だけが残り、**原因が完全に消える**
 * （CI で失敗したのに手元では再現せず、これで1往復無駄にした）。
 */
export function testDetail(r, s) {
    if (s.failing.length) return s.failing.slice(0, 5).map(f => `${f.name} — ${f.cause}`);
    const head = r.timedOut
        ? [`⏱ ${(r.ms / 1000).toFixed(1)}s で SIGKILL（上限に達した）`]
        : [`終了コード ${r.code}（テストの要約が出ていない = 途中で落ちた）`];
    const tail = r.output.split('\n').map(l => l.trim()).filter(Boolean).slice(-8);
    return [...head, ...tail];
}

