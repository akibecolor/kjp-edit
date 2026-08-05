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

/**
 * その argv は会話モード（stream-json を stdin から読む）か。
 *
 * 🚨 **送る側が形式を推測してはいけない。** 再接続では `chat` を渡していなかったので、
 *    戻ってきて1言送った瞬間に stream-json の1行ではなく生のテキストが stdin に書かれ、
 *    **`claude --input-format stream-json` が即 exit 1 で死んでいた**
 *    （実測: `Error parsing streaming input line: … SyntaxError`。
 *     走っている会話セッションに生の行を1本書くだけで落ちる）。
 *    keepAlive:true なので猶予では死なないのに、**入力形式の取り違えで文脈が丸ごと消える**
 *    — 「切断をまたいで会話が継続する」が UI 経路で成立していなかった（6回目のレビュー）。
 *    **判定は argv を根拠にする**（サーバは argv を返すので再接続でも復元できる）。
 * @param {string[]} argv
 * @returns {boolean}
 */
export function isChatArgv(argv) {
    if (!Array.isArray(argv)) return false;
    for (let i = 0; i < argv.length - 1; i++) {
        // `--input-format stream-json` と `--input-format=stream-json` の両方
        if (argv[i] === '--input-format' && argv[i + 1] === 'stream-json') return true;
    }
    return argv.includes('--input-format=stream-json');
}
