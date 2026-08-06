// SPDX-License-Identifier: MIT
// node --test v0/blobview.test.mjs
//
// 全文ビューア（#12）の「何行描いて、何を告知するか」。
//
// ここを app.html の中に置いていたら、**告知が消えても気付けない**。
// 「表示上限で省略したら必ず告知する」は宣言なので、宣言をテストで固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planBlobView, MAX_VIEW_LINES } from './blobview.mjs';

const blob = (text, extra = {}) => ({
    path: 'f.txt', ref: 'main', oid: 'a'.repeat(40),
    size: Buffer.byteLength(text ?? '', 'utf8'),
    tooLarge: false, binary: false, text, ...extra,
});

test('全文: 行に分けて、末尾の改行を余分な空行にしない', () => {
    const p = planBlobView(blob('a\nb\nc\n'));
    assert.equal(p.kind, 'text');
    assert.deepEqual(p.lines, ['a', 'b', 'c']);
    assert.equal(p.totalLines, 3);
    assert.equal(p.truncated, false);
    assert.deepEqual(p.notices, []);
});

// ⚠️ chatfilter で「改行で終わらない最後の行が永久に出ない」を実際に踏んでいる。
//    同じ形の取りこぼしを作らないことを固定する。
test('全文: 改行で終わらないファイルでも最後の行が消えない', () => {
    const p = planBlobView(blob('a\nb\nno-trailing-newline'));
    assert.deepEqual(p.lines, ['a', 'b', 'no-trailing-newline']);
    assert.equal(p.totalLines, 3);
});

test('全文: 空のファイルでも落ちない', () => {
    const p = planBlobView(blob(''));
    assert.equal(p.kind, 'text');
    assert.equal(p.totalLines, 1);
    assert.deepEqual(p.notices, []);
});

test('全文: 途中の空行は残る（行番号がずれると別の行を指す）', () => {
    const p = planBlobView(blob('a\n\nb\n'));
    assert.deepEqual(p.lines, ['a', '', 'b']);
});

test('全文: 表示上限で切ったら、切ったことと全体の行数を告知する', () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n')}\n`;
    const p = planBlobView(blob(text), { maxLines: 10 });
    assert.equal(p.truncated, true);
    assert.equal(p.shownLines, 10);
    assert.equal(p.lines.length, 10);
    assert.equal(p.lines.at(-1), 'L9');
    assert.equal(p.totalLines, 30);
    // 🚨 告知は**見える文字**として返る。数字も両方入っていること
    //    （「切りました」だけでは、どこまで見えているのか分からない）
    assert.equal(p.notices.length, 1, `告知が無い: ${JSON.stringify(p.notices)}`);
    assert.match(p.notices[0], /先頭 10 行/);
    assert.match(p.notices[0], /全 30 行/);
    assert.match(p.notices[0], /残り 20 行/);
});

test('全文: ちょうど上限のときは切らないし告知もしない（1行だけ余計に切らない）', () => {
    const text = `${Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n')}\n`;
    const p = planBlobView(blob(text), { maxLines: 10 });
    assert.equal(p.truncated, false);
    assert.equal(p.shownLines, 10);
    assert.deepEqual(p.notices, []);
});

test('既定の上限が使われる（呼び出し側が上限を二重に書かないため）', () => {
    const text = `${Array.from({ length: MAX_VIEW_LINES + 5 }, (_, i) => `L${i}`).join('\n')}\n`;
    const p = planBlobView(blob(text));
    assert.equal(p.shownLines, MAX_VIEW_LINES);
    assert.equal(p.truncated, true);
    assert.match(p.notices[0], new RegExp(`先頭 ${MAX_VIEW_LINES} 行`));
});

test('バイナリは中身を出さずに、バイナリだと告知する', () => {
    const p = planBlobView(blob(null, { binary: true, size: 1234 }));
    assert.equal(p.kind, 'binary');
    assert.deepEqual(p.lines, []);
    assert.equal(p.notices.length, 1);
    assert.match(p.notices[0], /バイナリ/);
    assert.match(p.notices[0], /1234 バイト/);
});

// サーバは 512KB で読むのをやめる（メモリを食い切らせない）。
// ⚠️ そのとき binary は null = **読んでいないので分からない**。
//    「テキストです」と偽らず、1行も出していないことを言う。
test('サーバの上限を超えたファイルは、読んでいないことと上限を告知する', () => {
    const p = planBlobView({
        path: 'big.bin', ref: 'main', oid: 'b'.repeat(40),
        size: 900000, tooLarge: true, binary: null, text: null, limitBytes: 524288,
    });
    assert.equal(p.kind, 'tooLarge');
    assert.deepEqual(p.lines, []);
    assert.equal(p.notices.length, 1);
    assert.match(p.notices[0], /900000 バイト/);
    assert.match(p.notices[0], /上限 524288 バイト/);
    assert.match(p.notices[0], /1行も表示していません/);
});

test('上限を超えたのにサイズが取れなかった場合も、黙らない', () => {
    const p = planBlobView({ tooLarge: true, size: null, binary: null, text: null });
    assert.equal(p.kind, 'tooLarge');
    assert.match(p.notices[0], /サイズ不明/);
});

test('応答が壊れていたら、読めなかったと言う（空の画面にしない）', () => {
    for (const bad of [null, undefined, 'nope', {}, { text: 42 }]) {
        const p = planBlobView(bad);
        assert.equal(p.kind, 'error', `${JSON.stringify(bad)} が error になっていない`);
        assert.equal(p.notices.length, 1, `${JSON.stringify(bad)} の告知が無い`);
        assert.match(p.notices[0], /読めませんでした/);
    }
});
