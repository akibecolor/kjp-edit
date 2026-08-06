// SPDX-License-Identifier: MIT
//
// 全文ビューア（ファイルの中身を読む）の「何行描いて、何を告知するか」。
//
// ⚠️ これは #12（埋め込みブラウザ / リッチ Markdown）**ではない**。
//    #12 は別オリジンからの配信が前提で v0 の単一オリジン構成と噛み合わないので
//    据え置き。ここは「差分だけでは今のファイルがどうなっているか読めない」を
//    埋めるだけの素のテキストビューア。
//
// 🚨 **app.html の中に置かない。** 中に置いたロジックはテストできないので、
//    「表示上限で省略したら必ず告知する」という宣言が破れても気付けない
//    （`makeChatFilter` が先頭コメントの約束を破っていたのに気付けなかったのと同じ形。#44）。
//    `ndjson.mjs` / `argv.mjs` / `chatfilter.mjs` と同じくサーバから配信して、
//    ブラウザと `node --test` が**同じコード**を読む。
//
// ⚠️ ここは「読んだ payload を画面用に整える」だけ。**認可も検証もしない。**
//    ref / path の検証はサーバ側の `isSafeRef` / `isSafeRepoPath` が持ち、
//    中身は `git cat-file` 経由でしか読まない（`fs` は使わない）。

/**
 * 1画面に描く行数の上限。
 *
 * 🚨 **実測で決めた（勘で決めていない）。** `?probe=1` の
 *    `window.__kjpRenderBlob(n, n)` は **UI と同じ `renderBlob`** に n 行を渡して
 *    「組み立て + レイアウト確定（`offsetHeight` を読む）」までの実時間を返す。
 *    headless Chrome（Windows 11 / 1400x1000 / 5回の中央値）:
 *
 *        500 行    9ms   [8, 9, 9, 9, 10]
 *       1000 行   20ms   [17, 17, 20, 21, 24]
 *       2000 行   42ms   [29, 33, 42, 43, 49]
 *       4000 行   85ms   [74, 82, 85, 105, 107]
 *       8000 行  149ms   [137, 140, 149, 151, 169]
 *      16000 行  340ms   [292, 301, 340, 347, 433]
 *      32000 行  613ms   [538, 595, 613, 686, 821]
 *
 *    予算は端末と同じ **最長ブロック 400ms**（`render-check.mjs`。それを超えると
 *    停止ボタンも 15 秒ごとの自動更新も効かない時間ができる）。
 *    **16000 行は中央値 340ms で、最悪のサンプルが 433ms = 予算超過**なので使えない。
 *    4000 行は 85ms（最悪 107ms）で 4 倍近い余裕があり、
 *    差分ペインを2枚開いて自動更新が重なっても予算に収まる。
 *    要素数でも一貫している: 4000 行 = 8000 span で、端末側の上限
 *    （`TERM_MAX_SPANS` = 4000 要素）と同じ桁。
 *    **下げすぎない理由**: 1000 行では普通のソースが切れて用を成さない
 *    （このリポジトリの `v0/smoke.test.mjs` は 4141 行）。
 *
 *    ⚠️ 線形（1行あたり約 21µs）なのは**1回だけ DOM に入れているから**。
 *    1行ごとに追加して `scrollHeight` を読む形にすると二次になる
 *    （同じ環境で実測: 1000 行 3.4秒 / 2000 行 14.5秒 / 4000 行 59.1秒）。
 *    それを外す変異（`blob-render-per-line-layout`）が入っている。
 */
export const MAX_VIEW_LINES = 4000;

/**
 * `/api/v0/blob` の payload を「描く行」と「告知」に分ける。
 *
 * 返り値の `notices` は**そのまま画面に出す文字**。
 * ⚠️ 呼び出し側は `dataset` のフラグではなく**この文字を描く**こと
 *    （フラグだけを検査すると、告知の要素を作らなくても検査が通る）。
 *
 * @param {?object} d `/api/v0/blob` の応答
 * @param {{maxLines?: number}} [o]
 * @returns {{kind: 'text'|'binary'|'tooLarge'|'error', lines: string[],
 *   shownLines: number, totalLines: number, truncated: boolean, notices: string[]}}
 */
export function planBlobView(d, { maxLines = MAX_VIEW_LINES } = {}) {
    const empty = (kind, notices) => ({
        kind, lines: [], shownLines: 0, totalLines: 0, truncated: false, notices,
    });
    if (!d || typeof d !== 'object') {
        return empty('error', ['中身を読めませんでした（応答が空です）。']);
    }
    const bytes = Number.isFinite(d.size) ? `${d.size} バイト` : 'サイズ不明';
    // サーバが上限で読むのをやめた場合。
    // ⚠️ **「読んでいない」ので binary かどうかも分からない。** 分からないことを
    //    「テキストです」と偽らない（サーバ側も binary: null を返している）。
    if (d.tooLarge) {
        const limit = Number.isFinite(d.limitBytes) ? `上限 ${d.limitBytes} バイト` : '上限超過';
        return empty('tooLarge', [
            `⚠ 大きすぎるのでサーバが中身を読んでいません（${bytes} / ${limit}）。`
            + ' 1行も表示していません。',
        ]);
    }
    if (d.binary) {
        return empty('binary', [`バイナリファイルなので表示しません（${bytes}）。`]);
    }
    if (typeof d.text !== 'string') {
        return empty('error', ['中身を読めませんでした（text がありません）。']);
    }
    const lines = d.text.split('\n');
    // ⚠️ 末尾の改行は「空行が1つある」ことを意味しないので落とす。
    //    ただし**改行で終わっていないファイルでは落とさない**（最後の行が消える）。
    //    `chatfilter` で「改行で終わらない最後の行が永久に出ない」を実際に踏んでいる。
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;
    const truncated = totalLines > maxLines;
    const shown = truncated ? lines.slice(0, maxLines) : lines;
    const notices = [];
    if (truncated) {
        notices.push(`⚠ 行が多いので先頭 ${maxLines} 行だけ表示しています`
            + `（全 ${totalLines} 行）。残り ${totalLines - maxLines} 行は表示していません。`);
    }
    return {
        kind: 'text', lines: shown, shownLines: shown.length, totalLines, truncated, notices,
    };
}
