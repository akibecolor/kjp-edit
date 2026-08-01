// SPDX-License-Identifier: MIT
// node --test v0/swimlanes.test.mjs
//
// 実装中に実際に踏んだ2つのバグの回帰テスト。
// docs/development.md の「エージェントが呼ぶ唯一の検証コマンド」の第1層。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSwimlanes } from './swimlanes.mjs';

/** h('a', 'b') → { hash: 'a', parents: ['b'] } */
const h = (hash, ...parents) => ({ hash, parents });

test('linear history stays on one lane', () => {
    const rows = computeSwimlanes([h('c', 'b'), h('b', 'a'), h('a')]);
    assert.deepEqual(rows.map(r => r.lane), [0, 0, 0]);
    assert.equal(Math.max(...rows.map(r => r.output.length)), 1);
});

test('root commit closes its lane', () => {
    const rows = computeSwimlanes([h('a')]);
    assert.equal(rows[0].output.length, 0);
    assert.equal(rows[0].firstParentLane, -1);
});

// 回帰1: 同じ親を指すレーンを重複排除しないと、1本しか消費されず残り続ける。
// 症状: 16コミットで13レーンになった。
test('regression: lanes converging on one commit are deduped', () => {
    // 兄弟 x, y が共通の親 p を持つ
    const rows = computeSwimlanes([h('x', 'p'), h('y', 'p'), h('p', 'g'), h('g')]);
    for (const r of rows) {
        const ids = r.output.map(o => o.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate lane ids: ${ids}`);
    }
    // p に到達した時点でレーンは1本に畳まれている
    assert.equal(rows[2].output.length, 1);
    // 兄弟が同じ親を共有する場合、開いているレーンは常に1本。
    // lane インデックス(1)が output.length-1(0) を超えるのは正常で、
    // 点は x(1) に描かれ線が x(0) へ降りる。SVG の幅計算は
    // max(input.length, output.length, lane+1) でなければならない。
    assert.equal(Math.max(...rows.map(r => r.output.length)), 1);
    assert.ok(rows[1].lane > rows[1].output.length - 1, 'lane may exceed output extent');
});

// 回帰2: しかし重複排除を lane の割当にも適用すると兄弟が同じレーンになる。
// 症状: agent-a と agent-b が両方 lane 0 になった。
test('regression: sibling branches get distinct lanes', () => {
    const rows = computeSwimlanes([h('x', 'p'), h('y', 'p'), h('p')]);
    assert.equal(rows[0].lane, 0, 'first sibling on lane 0');
    assert.equal(rows[1].lane, 1, 'second sibling must NOT share lane 0');
    // どちらも親レーン0へ着地する
    assert.equal(rows[0].firstParentLane, 0);
    assert.equal(rows[1].firstParentLane, 0);
});

test('merge commit opens a lane for the second parent', () => {
    const rows = computeSwimlanes([h('m', 'a', 'b'), h('a', 'r'), h('b', 'r'), h('r')]);
    assert.equal(rows[0].lane, 0);
    assert.equal(rows[0].output.length, 2, 'both parents get lanes');
    assert.deepEqual(rows[0].output.map(o => o.id), ['a', 'b']);
});

test('lane colors are stable for a continuing branch', () => {
    const rows = computeSwimlanes([h('c', 'b'), h('b', 'a'), h('a')]);
    assert.equal(rows[0].color, rows[1].color);
    assert.equal(rows[1].color, rows[2].color);
});

test('a commit not reachable from any open lane starts a fresh lane', () => {
    // 表示範囲外の子を持つ孤立した枝
    const rows = computeSwimlanes([h('x', 'p'), h('orphan', 'q'), h('p'), h('q')]);
    assert.equal(rows[0].lane, 0);
    assert.equal(rows[1].lane, 1, 'orphan must not collide with the open p lane');
});
