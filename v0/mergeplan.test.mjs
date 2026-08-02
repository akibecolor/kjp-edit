// SPDX-License-Identifier: MIT
// node --test v0/mergeplan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMerge } from './mergeplan.mjs';

const c = (label, ahead = 1) => ({ label, ahead });
const pair = (a, b, clean) => ({ a, b, clean });

test('衝突が無ければ全部まとめて取り込める', () => {
    const r = planMerge([c('a'), c('b'), c('c')], [
        pair('a', 'b', true), pair('a', 'c', true), pair('b', 'c', true),
    ]);
    assert.deepEqual(r.batch.sort(), ['a', 'b', 'c']);
    assert.deepEqual(r.deferred, []);
    assert.equal(r.untestedPairs, 0);
});

test('衝突するペアは片方だけを塊に入れ、もう片方を相手つきで後回しにする', () => {
    const r = planMerge([c('a'), c('b')], [pair('a', 'b', false)]);
    assert.equal(r.batch.length, 1);
    assert.equal(r.deferred.length, 1);
    assert.deepEqual(r.deferred[0].conflictsWith, r.batch);
});

test('独立集合を取る（全員と衝突する1本を外して残りをまとめる）', () => {
    // hub が a/b/c 全部と衝突する。hub を外せば a,b,c はまとめて入る
    const r = planMerge([c('hub'), c('a'), c('b'), c('c')], [
        pair('hub', 'a', false), pair('hub', 'b', false), pair('hub', 'c', false),
        pair('a', 'b', true), pair('a', 'c', true), pair('b', 'c', true),
    ]);
    assert.deepEqual(r.batch.sort(), ['a', 'b', 'c'], `hub が塊に入っている: ${r.batch}`);
    assert.deepEqual(r.deferred.map(d => d.label), ['hub']);
    assert.deepEqual(r.deferred[0].conflictsWith, ['a', 'b', 'c']);
});

test('塊の中身は互いに衝突しない（不変条件）', () => {
    // 環状に衝突する4本
    const conflicts = [
        pair('a', 'b', false), pair('b', 'c', false),
        pair('c', 'd', false), pair('d', 'a', false),
        pair('a', 'c', true), pair('b', 'd', true),
    ];
    const r = planMerge([c('a'), c('b'), c('c'), c('d')], conflicts);
    const bad = new Set(conflicts.filter(x => !x.clean).map(x => [x.a, x.b].sort().join('|')));
    for (let i = 0; i < r.batch.length; i++) {
        for (let j = i + 1; j < r.batch.length; j++) {
            const k = [r.batch[i], r.batch[j]].sort().join('|');
            assert.ok(!bad.has(k), `塊の中に衝突ペアが入っている: ${k}`);
        }
    }
    assert.ok(r.batch.length >= 2, `独立集合が小さすぎる: ${r.batch}`);
});

// ⚠️ 検査していないペアを「衝突しない」と断定しないための材料。
//    候補はファイルが重なるペアだけなので、大半のペアは未検査になる。
test('検査していないペアの数を返す', () => {
    // 3本 = 3ペアのうち1ペアしか検査していない
    const r = planMerge([c('a'), c('b'), c('c')], [pair('a', 'b', false)]);
    assert.equal(r.testedPairs, 1);
    assert.equal(r.untestedPairs, 2);
});

test('候補に無いラベルのペアは無視する', () => {
    const r = planMerge([c('a'), c('b')], [pair('a', 'zzz', false), pair('a', 'b', true)]);
    assert.deepEqual(r.batch.sort(), ['a', 'b']);
    assert.equal(r.testedPairs, 1, '候補外のペアを数えている');
});

test('結果は決定的（入力順を変えても同じ）', () => {
    const cands = [c('a', 3), c('b', 1), c('c', 2)];
    const conf = [pair('a', 'b', false), pair('a', 'c', true), pair('b', 'c', true)];
    const r1 = planMerge(cands, conf);
    const r2 = planMerge([...cands].reverse(), [...conf].reverse());
    assert.deepEqual(r1, r2);
});

test('候補が0本でも落ちない', () => {
    const r = planMerge([], []);
    assert.deepEqual(r, { batch: [], deferred: [], untestedPairs: 0, testedPairs: 0 });
});

test('同じ次数なら ahead が多い方を先に取る', () => {
    // 誰も衝突しない → 全部入るが、batch の順序は ahead の多い順
    const r = planMerge([c('few', 1), c('many', 9), c('mid', 5)], []);
    assert.deepEqual(r.batch, ['many', 'mid', 'few']);
});
