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

    // ⚠️ 塊に入らなかったものは **deferred（衝突が分かっている）** と
    //    **unknown（未検査）** を区別して返さないといけない。
    //    衝突が分かっているものを「未検査」と出すのは UI 上の嘘になり、
    //    「じゃあ検査すればいける」と読める（実際そうならない）。
    //    batch の条件は「全ペアが検査済みかつ clean」なので、
    //    衝突チェックを外しても塊自体は汚れない = 上のループでは捕まらない。
    //    振り分けを固定することで初めてこの守りが検証される。
    const deferredLabels = r.deferred.map(d => d.label);
    const unknownLabels = r.unknown.map(u => u.label);
    for (const l of ['a', 'b', 'c', 'd']) {
        if (r.batch.includes(l)) continue;
        assert.ok(deferredLabels.includes(l),
            `衝突が分かっている ${l} が deferred に無い（unknown: ${unknownLabels}）`);
    }
    for (const d of r.deferred) {
        assert.ok((d.conflictsWith?.length ?? 0)
            + (d.conflictsWithBatch?.length ?? 0)
            + (d.conflictsWithDeferred?.length ?? 0) > 0,
        `deferred なのに衝突相手が空: ${d.label}`);
    }
});

// ⚠️ 検査していないペアを「衝突しない」と断定しないための材料。
//    候補はファイルが重なるペアだけなので、大半のペアは未検査になる。
test('検査していないペアの数を返す', () => {
    // 3本 = 3ペアのうち1ペアしか検査していない
    const r = planMerge([c('a'), c('b'), c('c')], [pair('a', 'b', false)]);
    assert.equal(r.testedPairs, 1);
    assert.equal(r.untestedPairs, 2);
});

// 🚨 #2: submodule は git が「trivial なケースしか対応しない」と言うので
//    `clean: null`（不明）になる。以前は「true 以外は安全でない側」に置いていたので、
//    **判定できないペアが「衝突する」として提示**されていた（嘘）。
test('🚨 clean=null（不明）は衝突ではなく「未検査」として扱う', () => {
    const r = planMerge([c('a'), c('b')], [{ a: 'a', b: 'b', clean: null }]);
    // 衝突として提示してはいけない
    assert.deepEqual(r.deferred, [], '不明を「衝突する」として出している');
    // どちらか一方は塊に入るが、相手は「不明」に落ちる
    assert.equal(r.batch.length, 1, `塊の中身: ${JSON.stringify(r.batch)}`);
    assert.equal(r.unknown.length, 1, `不明: ${JSON.stringify(r.unknown)}`);
    assert.deepEqual(r.unknown[0].untestedWith, r.batch);
    // 検査済みに数えない（数えると「検査したのに分からない」が見えなくなる）
    assert.equal(r.testedPairs, 0, '不明を検査済みに数えている');
    assert.equal(r.untestedPairs, 1);
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
    assert.deepEqual(r, {
        batch: [], deferred: [], unknown: [], untestedPairs: 0, testedPairs: 0,
    });
});

// 🚨 未検査のペアを「衝突しない」と扱わない。以前は辺が無いだけで batch に入れていたので、
//    実際に衝突する2本が「まとめて取り込める」と提示された（レビューで実測）。
test('regression: 未検査のペアは batch に同居させず unknown に落とす', () => {
    // 誰も検査していない → 最初の1本だけが batch、残りは unknown
    const r = planMerge([c('a', 3), c('b', 2), c('c', 1)], []);
    assert.equal(r.batch.length, 1, `未検査なのに複数が batch に入った: ${r.batch}`);
    assert.deepEqual(r.unknown.map(u => u.label).sort(), ['b', 'c']);
    assert.deepEqual(r.unknown[0].untestedWith, r.batch);
});

test('検査済みで clean なら batch に同居できる', () => {
    const r = planMerge([c('a', 3), c('b', 2), c('c', 1)], [
        pair('a', 'b', true), pair('a', 'c', true), pair('b', 'c', true),
    ]);
    assert.deepEqual(r.batch.sort(), ['a', 'b', 'c']);
    assert.deepEqual(r.unknown, []);
});

test('同じ次数なら ahead が多い方を先に取る', () => {
    // 全ペアを clean として検査済みにしておく（そうしないと unknown に落ちる）
    const r = planMerge([c('few', 1), c('many', 9), c('mid', 5)], [
        pair('few', 'many', true), pair('few', 'mid', true), pair('many', 'mid', true),
    ]);
    assert.deepEqual(r.batch, ['many', 'mid', 'few']);
});

// 🚨 deferred 同士の衝突が見えないと「a を入れて b と c を手当」と読めるが、
//    b と c も衝突する、という2周目の驚きが起きる（レビューで指摘）。
test('regression: deferred 同士の衝突も報告する', () => {
    // 三角形（3本が互いに衝突）
    const r = planMerge([c('a'), c('b'), c('c')], [
        pair('a', 'b', false), pair('a', 'c', false), pair('b', 'c', false),
    ]);
    assert.equal(r.batch.length, 1);
    const b = r.deferred.find(d => d.label !== r.batch[0]);
    assert.ok(b, `deferred が無い: ${JSON.stringify(r)}`);
    assert.equal(b.conflictsWith.length, 2, `全隣接が出ていない: ${b.conflictsWith}`);
    assert.equal(b.conflictsWithDeferred.length, 1,
        `deferred 同士の衝突が見えない: ${JSON.stringify(b)}`);
});

// 🚨 ラベルは衝突しうる（`x/same/dup` と `y/same/dup` はどちらも `same/dup`）。
test('regression: 重複ラベルを batch に2回出さない', () => {
    const r = planMerge([c('dup', 1), c('dup', 2), c('x', 1)], [pair('dup', 'x', true)]);
    assert.equal(new Set(r.batch).size, r.batch.length, `重複がある: ${r.batch}`);
});

test('自己ペア（a × a）は無視する', () => {
    const r = planMerge([c('a'), c('b')], [pair('a', 'a', true), pair('a', 'b', true)]);
    assert.equal(r.testedPairs, 1, '自己ペアを数えている');
    assert.deepEqual(r.batch.sort(), ['a', 'b']);
});

// 不明（clean === null。読み切れなかった等）は「安全」側に置かない
// ⚠️ このテストは以前「clean が null のペアは**衝突側**として扱う」だった。
//    それは**嘘を固定していた**（#2）。判定できないものを「衝突する」と
//    提示するのは、`{clean:false, conflicts:[]}` を返していた過去の不具合と同型。
//    今は「未検査」= ③ 不明に落ちる（上のテストが新しい契約を固定している）。
test('clean が null のペアを「衝突する」と提示しない（安全側だが嘘は言わない）', () => {
    const r = planMerge([c('a'), c('b')], [{ a: 'a', b: 'b', clean: null }]);
    assert.equal(r.batch.length, 1, '両方を塊に入れてはいけない（未検査なので）');
    assert.deepEqual(r.deferred, [], '不明を衝突として提示している');
    assert.equal(r.unknown.length, 1, '不明として提示していない');
});
