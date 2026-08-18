// SPDX-License-Identifier: MIT
//
// ソースそのものの検査（`verify.mjs` の syntax 段が使う純関数）。
//
// 🚨 **なぜ verify.mjs の中に書かないか。**
//    中に書くと**この検査自身が検査されない**。実際、生の制御文字の規則は
//    CLAUDE.md に書いてあったのに**検査が1件も無く**、`v0/git.mjs` に続いて
//    `v0/app.html` でも同じ事故を起こした（git がファイルを binary と判定し、
//    `git diff` / `git log -p` / `git grep` の全部から見えなくなる）。
//    ここに出せば unit と変異で「守りを外すと落ちる」を固定できる。

/**
 * 🔒 **生の制御文字を探す。** 許すのは tab (09) / LF (0a) / CR (0d) だけ。
 *
 * NUL を1個入れるだけで git がそのファイルを **binary** と判定し、
 * レビューの手段が全部消える。ソースには**エスケープ表記**を書くこと。
 *
 * @param {Buffer|Uint8Array} buf ファイルの中身（**バイトで**見る。文字列にすると
 *   デコードで化けたものと区別が付かない）
 * @returns {{offset: number, byte: number}|null} 無ければ null
 */
export function findControlChar(buf) {
    const bytes = buf ?? [];
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if (c < 0x09 || (c > 0x0d && c < 0x20) || c === 0x7f) {
            return { offset: i, byte: c };
        }
    }
    return null;
}

/**
 * ⚠️ **workflow スクリプトを `node --check` に掛けられる形に包む。**
 *
 * workflow は top-level `return` と `export const meta` を使うので、素で
 * `--check` すると**必ず** `Illegal return statement` になり、
 * 「本当の構文エラー」と区別が付かない。だから `export` を外して async 関数に包む。
 *
 * 🚨 **実行はしない**（エージェントを起動してしまう）。構文だけ見る。
 *
 * @param {string} src
 * @returns {string} `node --check` に渡せるソース
 */
export function wrapWorkflowForCheck(src) {
    const body = String(src ?? '').split('\n')
        .map(l => l.replace(/^export const /, 'const '))
        .join('\n');
    return 'const args = {}, budget = {};\n'
        + 'function log(){} function phase(){} async function agent(){}\n'
        + 'async function pipeline(){} async function parallel(){}\n'
        + 'async function workflow(){}\n'
        + `async function __main() {\n${body}\n}\n`;
}
