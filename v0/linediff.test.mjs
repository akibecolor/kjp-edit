// SPDX-License-Identifier: MIT
// node --test v0/linediff.test.mjs
//
// 「保存する前に何が変わるか見せる」ための差分。**嘘の差分は最悪**なので、
// 「変わっていないのに差分が出る」「変わったのに出ない」の両方を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, MAX_DIFF_CELLS } from './linediff.mjs';

/** `-`/`+` の行だけ取り出す（ヘッダと文脈を除く） */
const changes = r => r.lines.filter(l => l.startsWith('-') || l.startsWith('+'));

test('同じ内容なら差分の行は1つも出ない', () => {
    const r = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    assert.deepEqual(r.lines, []);
    assert.equal(r.added, 0);
    assert.equal(r.removed, 0);
    assert.equal(r.trailingNewlineChanged, false);
});

test('1行だけ変えたら、その1行だけが変更として出る', () => {
    // 期待値を先に言語化する: 3行のうち真ん中だけ違うので、
    // 出るのは `-b` と `+B` の2行だけ。他の行は文脈（先頭が空白）。
    const r = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    assert.deepEqual(changes(r), ['-b', '+B']);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 1);
    assert.ok(r.lines[0].startsWith('@@'), `ヘッダが無い: ${JSON.stringify(r.lines)}`);
    assert.ok(r.lines.includes(' a'), '文脈が出ていない');
});

test('末尾に追加したら追加だけが出る（前の行を書き換えたことにしない）', () => {
    const r = diffLines('a\nb\n', 'a\nb\nc\n');
    assert.deepEqual(changes(r), ['+c']);
    assert.equal(r.removed, 0);
});

test('行を消したら削除だけが出る', () => {
    const r = diffLines('a\nb\nc\n', 'a\nc\n');
    assert.deepEqual(changes(r), ['-b']);
    assert.equal(r.added, 0);
});

test('離れた2箇所の変更は別の塊（@@）になる', () => {
    const a = Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n');
    const b = a.split('\n').map((l, i) => (i === 2 || i === 25 ? `${l}!` : l)).join('\n');
    const r = diffLines(a, b);
    const heads = r.lines.filter(l => l.startsWith('@@'));
    assert.equal(heads.length, 2, `塊が ${heads.length} 個: ${JSON.stringify(heads)}`);
    // 30行のうち文脈±3行しか出さない（全文を出していないこと）
    assert.ok(r.lines.length < 20, `全文を出している: ${r.lines.length} 行`);
});

test('文脈の行数を 0 にできる', () => {
    const r = diffLines('a\nb\nc\n', 'a\nB\nc\n', { context: 0 });
    assert.deepEqual(r.lines, ['@@ -2,1 +2,1 @@', '-b', '+B']);
});

test('末尾の改行だけの違いを告知する（行の配列には出ないので）', () => {
    // 🚨 ここを告知しないと「差分なし」と出たまま保存でバイト列が変わる
    const r = diffLines('a\nb\n', 'a\nb');
    assert.equal(r.trailingNewlineChanged, true);
    // 逆向きも
    assert.equal(diffLines('a\nb', 'a\nb\n').trailingNewlineChanged, true);
    // 空 → 空 では騒がない
    assert.equal(diffLines('', '').trailingNewlineChanged, false);
});

test('変更範囲が大きいときは行の対応を取らず、そう告知する', () => {
    // 🚨 上限を超えたら黙って端折らない（「全部見た」と読まれる）
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`).join('\n');
    const r = diffLines(a, b, { maxCells: 100 });
    assert.equal(r.approx, true);
    assert.match(r.why, /行の対応は取っていません/);
    assert.equal(r.removed, 40);
    assert.equal(r.added, 40);
    // 上限が十分なら対応を取る（同じ入力で approx にならないこと）
    const r2 = diffLines(a, b, { maxCells: MAX_DIFF_CELLS });
    assert.equal(r2.approx, false);
    assert.equal(r2.why, null);
});

test('共通の先頭・末尾が長くても上限を無駄に使わない', () => {
    // 先頭と末尾が同じなら、真ん中だけが LCS の対象になる。
    // 1000行の共通部分があっても maxCells が小さくても approx にならないこと。
    const common = Array.from({ length: 1000 }, (_, i) => `same${i}`).join('\n');
    const r = diffLines(`${common}\nx\n${common}`, `${common}\ny\n${common}`, { maxCells: 16 });
    assert.equal(r.approx, false, '共通部分を落とせていない（上限を無駄に使っている）');
    assert.deepEqual(changes(r), ['-x', '+y']);
});

test('空 → 内容ありと、その逆を扱える', () => {
    assert.deepEqual(changes(diffLines('', 'a\n')), ['+a']);
    assert.deepEqual(changes(diffLines('a\n', '')), ['-a']);
    assert.deepEqual(diffLines('', '').lines, []);
});

test('null / undefined を渡しても落ちない', () => {
    assert.deepEqual(diffLines(null, undefined).lines, []);
    assert.deepEqual(changes(diffLines(null, 'a\n')), ['+a']);
});
