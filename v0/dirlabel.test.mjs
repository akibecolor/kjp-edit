// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueLabels, collisionFullLabels } from './dirlabel.mjs';

test('衝突しなければ basename だけ', () => {
    assert.deepEqual(uniqueLabels(['C:/src/repo/wt-a', 'C:/src/repo/wt-b']), ['wt-a', 'wt-b']);
});

// 🚨 #50 の本体。並列でエージェントを回すと**この形**になる。
test('basename が衝突したら、必要な分だけ親を足す', () => {
    assert.deepEqual(
        uniqueLabels(['C:/src/a/wt-main', 'C:/src/b/wt-main']),
        ['a/wt-main', 'b/wt-main']);
});

test('親も衝突するなら、さらに上まで足す', () => {
    assert.deepEqual(
        uniqueLabels(['C:/x/proj/wt', 'D:/y/proj/wt']),
        ['x/proj/wt', 'y/proj/wt']);
});

test('衝突しているものだけ伸ばす（無関係な行を長くしない）', () => {
    assert.deepEqual(
        uniqueLabels(['C:/src/a/wt-main', 'C:/src/b/wt-main', 'C:/src/other/solo']),
        ['a/wt-main', 'b/wt-main', 'solo']);
});

test('区切り文字が混ざっていても同じに扱う（git は / 、path.join は \\）', () => {
    assert.deepEqual(
        uniqueLabels(['C:\\src\\a\\wt-main', 'C:/src/b/wt-main']),
        ['a/wt-main', 'b/wt-main']);
});

test('完全に同じパスが2つ来ても止まる（無限ループにしない）', () => {
    const out = uniqueLabels(['C:/src/a/wt', 'C:/src/a/wt']);
    assert.equal(out.length, 2);
    assert.deepEqual(out, [out[0], out[0]], '同じパスなら同じラベルで良い');
    // ⚠️ 伸ばし切っても区別できないので、**呼び出し側が別の印（id）を足す**必要がある。
    //    それが要ることをここで固定する（ラベルだけに頼らせない）。
});

test('空・不正な入力で落ちない', () => {
    assert.deepEqual(uniqueLabels([]), []);
    assert.deepEqual(uniqueLabels(null), []);
    assert.deepEqual(uniqueLabels(['', null, undefined]), ['', '', '']);
    assert.deepEqual(uniqueLabels(['/']), ['/']);
});

test('選択リスト用は衝突でフルパスに落とす（曖昧さを完全に消す）', () => {
    assert.deepEqual(
        collisionFullLabels(['C:/p/same', 'C:/q/same']),
        ['C:/p/same', 'C:/q/same']);
    assert.deepEqual(
        collisionFullLabels(['C:/p/alpha', 'C:/q/bravo']),
        ['alpha', 'bravo']);
});
