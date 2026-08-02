// SPDX-License-Identifier: MIT
//
// コマンド行を argv に分ける。**shell は使わないので自分で分ける。**
// ブラウザと unit テストで共有する（app.html の中に置くとテストできない。
// ndjson.mjs を切り出したのと同じ理由）。
//
// 扱うのはクォートとエスケープだけ。パイプ・リダイレクト・グロブ・変数展開は
// 扱わない（扱えるように見せると危ないので、できないことを UI に明示する）。
//
// ⚠️ レビューで見つかった穴を直したもの:
//   - `don't panic` が `dont panic` に融合していた（アポストロフィが
//     クォート開始と解釈され、閉じないまま行末まで飲み込む）
//   - `"say \"hi\""` が `say \hi\` になっていた（エスケープ機構が無かった）
//   - 閉じていないクォートを無警告で受理していた

/**
 * @param {string} line
 * @returns {{argv: string[], warning: string|null}}
 */
export function splitArgv(line) {
    const argv = [];
    let cur = '', quote = null, has = false, warning = null;
    const src = String(line ?? '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        // バックスラッシュのエスケープ。
        // ⚠️ Windows のパス（C:\a\b）を壊さないよう、**クォートの外では
        //    エスケープとして扱わない**。sh とは違うがこの UI では実用を採る。
        if (quote === '"' && ch === '\\' && i + 1 < src.length) {
            const next = src[i + 1];
            if (next === '"' || next === '\\') { cur += next; i++; continue; }
            cur += ch;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
        if (/\s/.test(ch)) {
            if (has || cur) { argv.push(cur); cur = ''; has = false; }
            continue;
        }
        cur += ch;
    }
    if (quote) {
        // 閉じていないクォートは黙って受理しない。呼び出し側が実行を止める
        warning = `クォート（${quote}）が閉じていません`;
    }
    if (has || cur) argv.push(cur);
    return { argv, warning };
}
