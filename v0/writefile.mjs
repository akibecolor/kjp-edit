// SPDX-License-Identifier: MIT
//
// 作業ツリーにファイル内容を書くための「バイト列の扱い」だけを持つモジュール。
//
// なぜ server.mjs から外に出すか: **中に書いたロジックはテストできない**
// （`app.html` の中に置いたものが宣言を破っていたのと同じ理由。`docs/review-5-6-parallel.md`）。
// 改行コードと BOM の保存は「壊れても画面上は同じに見える」種類の破壊なので、
// 純関数にしてユニットテストで固定する。
//
// 🚨 **ここは「触っていない行を変えない」ことを守る場所。**
//    エディタから保存するたびに改行コードが LF に寄ると、diff は全行変更になり、
//    並行して動いている別のエージェントの作業を丸ごと衝突させる
//    （N 本の worktree が同じファイルを触る前提のツールでは致命的）。

import { createHash } from 'node:crypto';

/** 画面から編集してよい上限。git.mjs の MAX_BLOB_BYTES と同じ値にしている。 */
export const MAX_EDIT_BYTES = 512 * 1024;

const BOM_BYTES = [0xEF, 0xBB, 0xBF];

/**
 * git の blob OID と同じ計算（`sha1("blob <len>\0" + 中身)`）。
 *
 * 🚨 **`git hash-object` を使わない。** 既定では**パスに対応する clean filter を
 *    起動する**（`.gitattributes` の `filter=…` + config の任意コマンド）。
 *    merge driver / `core.fsmonitor` / `diff.textconv` と同じクラスの穴なので、
 *    「ハッシュを取るだけ」でリポジトリ設定のコードを走らせない。
 * ⚠️ sha256 リポジトリでは git 自身の OID とは一致しない。**この値は
 *    「読んだときと同じ中身か」を照合するためだけに使う**（サーバが計算した値を
 *    クライアントがそのまま返す形。git の OID と突き合わせる用途には使わない）。
 */
export function blobOid(buf) {
    return createHash('sha1')
        .update(`blob ${buf.length}\0`, 'utf8')
        .update(buf)
        .digest('hex');
}

/**
 * 作業ツリーのバイト列を調べる。**書き戻すときに再現するべき性質**を集める。
 *
 * @returns {{bom: boolean, binary: boolean, eol: 'lf'|'crlf'|'cr', mixed: boolean,
 *            counts: {crlf: number, lf: number, cr: number}, oid: string, bytes: number}}
 *
 * ⚠️ `mixed`（改行コードが混在）は**呼び出し側が拒否する**ための情報。
 *    どちらに寄せても「触っていない行」が変わるので、推測して直さない
 *    （「分からないなら分からないと言う」）。
 */
export function inspectBytes(buf) {
    const bom = buf.length >= 3
        && buf[0] === BOM_BYTES[0] && buf[1] === BOM_BYTES[1] && buf[2] === BOM_BYTES[2];
    const body = bom ? buf.subarray(3) : buf;
    // git と同じ判定（先頭 8000 バイトに NUL があれば binary）
    const binary = body.subarray(0, 8000).includes(0);
    let crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === 0x0A) {
            if (i > 0 && body[i - 1] === 0x0D) crlf++;
            else lf++;
        } else if (c === 0x0D && body[i + 1] !== 0x0A) {
            cr++;
        }
    }
    const styles = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
    return {
        bom,
        binary,
        // 改行が1つも無いファイルは 'lf' 扱い（書き戻しても差が出ない）
        eol: crlf > 0 ? 'crlf' : cr > 0 ? 'cr' : 'lf',
        mixed: styles > 1,
        counts: { crlf, lf, cr },
        oid: blobOid(buf),
        bytes: buf.length,
    };
}

/**
 * 編集用のテキストにする。BOM を落として改行を LF に畳む
 * （`<textarea>` の value は仕様上 LF なので、往復で形が変わらないように揃える）。
 *
 * 🚨 **`toNFC` を掛けない。** パスは NFC に正規化するが、**中身は触らない**。
 *    NFD で書かれたファイルを NFC にして書き戻すと、**利用者が編集していない
 *    文字まで変わる**（macOS で作られたファイルで必ず起きる）。
 */
export function toEditorText(buf) {
    const bom = buf.length >= 3
        && buf[0] === BOM_BYTES[0] && buf[1] === BOM_BYTES[1] && buf[2] === BOM_BYTES[2];
    const body = bom ? buf.subarray(3) : buf;
    return body.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 編集後のテキストを、元のファイルの流儀（BOM / 改行コード）で書き戻す形にする。
 *
 * @param {string} text LF 前提のテキスト（`<textarea>` から来る形）
 * @param {{bom?: boolean, eol?: 'lf'|'crlf'|'cr'}} style `inspectBytes()` の結果を渡す
 */
export function encodeForWorktree(text, { bom = false, eol = 'lf' } = {}) {
    if (typeof text !== 'string') throw new TypeError('text が文字列ではありません');
    // ⚠️ クライアントが BOM を文字として送ってきても二重にしない
    //    （BOM はバイト列の性質として別に持っている）。
    //    ⚠️ 生の U+FEFF をソースに書かない（見えない文字は読めない。規則7と同じ理屈）。
    const noBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
    const lf = noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const out = eol === 'crlf'
        ? lf.replace(/\n/g, '\r\n')
        : eol === 'cr' ? lf.replace(/\n/g, '\r') : lf;
    const body = Buffer.from(out, 'utf8');
    return bom ? Buffer.concat([Buffer.from(BOM_BYTES), body]) : body;
}
