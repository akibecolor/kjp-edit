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

/**
 * 🚨 **argv を画面に出すための1行にする（上限つき）。**
 *
 * 監視盤とコンソールは argv をそのまま `join(' ')` で出していたので、
 * `node -e '<スクリプト>'` のような**巨大な引数がそのまま流れ込み**、
 * スマホの狭い画面では**1セッションの行が画面数枚分**になった（実機で指摘された）。
 * 改行を含む引数もそのまま出ていた。
 *
 * ⚠️ **省略したら必ず告知する**（`clipped` を返す。呼び出し側が言う）。
 *    黙って縮めると「これが全部のコマンドだ」と読める。
 * ⚠️ 引数ごとに縮める。**末尾のフラグ（`--input-format stream-json` など）を
 *    落とさない**ため（先頭から一定文字数で切ると、何のモードで動いているか消える）。
 *
 * @param {string[]} argv
 * @param {{maxArg?: number, maxTotal?: number}} [limits]
 * @returns {{text: string, clipped: boolean}}
 */
export function argvSummary(argv, { maxArg = 48, maxTotal = 300 } = {}) {
    const list = Array.isArray(argv) ? argv : [];
    let clipped = false;
    const parts = list.map(a => {
        // 改行やタブを含む引数（`-e` のスクリプト）は1行に潰す
        const flat = String(a ?? '').replace(/\s+/g, ' ').trim();
        if (flat.length <= maxArg) return flat;
        clipped = true;
        return `${flat.slice(0, maxArg)}…(${flat.length}文字)`;
    });
    let text = parts.join(' ');
    if (text.length > maxTotal) {
        text = `${text.slice(0, maxTotal)}…`;
        clipped = true;
    }
    return { text, clipped };
}
