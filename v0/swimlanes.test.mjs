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

// 回帰3: 第二親がどの output レーンに降りたかを記録していなかった。
// 症状: index.html は第一親への線しか引けず、マージの第二親レーンが
// 行の途中から何にも繋がらずに生えて見えた。
test('regression: merge records where each extra parent landed', () => {
    const rows = computeSwimlanes([h('m', 'a', 'b'), h('a', 'r'), h('b', 'r'), h('r')]);
    const m = rows[0];
    assert.deepEqual(m.mergeParentLanes, [1], 'second parent lands on lane 1');
    // 記録されたレーンは必ず output の実在インデックスで、第二親のIDを指す
    const parents = ['a', 'b'];
    for (const [k, lane] of m.mergeParentLanes.entries()) {
        assert.ok(lane >= 0 && lane < m.output.length, `lane ${lane} out of range`);
        assert.equal(m.output[lane].id, parents[k + 1]);
    }
    // 第一親と第二親が同じレーンに来てはいけない（線が重なって区別できない）
    assert.ok(!m.mergeParentLanes.includes(m.firstParentLane));
});

test('octopus merge records every extra parent', () => {
    const rows = computeSwimlanes([h('m', 'a', 'b', 'c'), h('a'), h('b'), h('c')]);
    assert.equal(rows[0].mergeParentLanes.length, 2);
    assert.equal(new Set(rows[0].mergeParentLanes).size, 2, 'distinct lanes');
});

test('merge into an already-open lane reuses it instead of duplicating', () => {
    // b は m より前に別の子から開かれている
    const rows = computeSwimlanes([h('x', 'b'), h('m', 'a', 'b'), h('a'), h('b')]);
    const m = rows[1];
    const ids = m.output.map(o => o.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate lane ids: ${ids}`);
    assert.equal(m.output[m.mergeParentLanes[0]].id, 'b');
});

// 回帰4: パレットが5色しかなく、色の選択も「今使っている色」を見ていなかった。
// 症状: エージェント用ブランチが6本並ぶと隣接レーンが同色で区別できない。
test('regression: ten branch heads open at once get distinct lane colors', () => {
    // 10本の枝が「同時に開いたまま」になる形にする。
    // s_i は固有の親 p_i を持ち、p_i は表示範囲の下にあるのでレーンが畳まれない。
    const n = 10;
    const commits = [];
    for (let i = 0; i < n; i++) commits.push(h(`s${i}`, `p${i}`));
    for (let i = 0; i < n; i++) commits.push(h(`p${i}`));
    const rows = computeSwimlanes(commits);

    // 10本が別レーンに並ぶ
    assert.deepEqual(rows.slice(0, n).map(r => r.lane), [...Array(n).keys()]);

    // 10本すべて開いている行で、色が互いに異なること（本題）
    const widest = rows[n - 1];
    assert.equal(widest.output.length, n, 'all ten lanes stay open');
    const colors = widest.output.map(o => o.color);
    assert.equal(new Set(colors).size, n, `duplicate open-lane colors: ${colors}`);

    // どの行でも、同時に開いているレーンの色は衝突しない
    for (const r of rows) {
        const c = r.output.map(o => o.color);
        assert.equal(new Set(c).size, c.length,
            `row ${r.hash}: duplicate open-lane colors ${c}`);
    }
});

// 兄弟が同じ親に即座に合流する場合、開いているレーンは1本に畳まれる。
// よって2本目以降の枝先は毎回「最初の空きスロット = 1」に座る。
// 同じ行に2つの点が出るわけではないので視覚的な衝突は起きない。
// （当初これを lane 0..9 になると誤解してテストを書いた。実装ではなくテストが誤り）
test('sibling heads converging on one parent reuse the first free slot', () => {
    const n = 10;
    const commits = [];
    for (let i = 0; i < n; i++) commits.push(h(`s${i}`, 'p'));
    commits.push(h('p'));
    const rows = computeSwimlanes(commits);

    assert.deepEqual(rows.slice(0, n).map(r => r.lane), [0, ...Array(n - 1).fill(1)]);
    assert.equal(Math.max(...rows.map(r => r.output.length)), 1, 'only one lane stays open');
    // 点の色は枝ごとに変わる（同じ行に並ばないので色の再利用は許される）
    const dotColors = rows.slice(0, n).map(r => r.color);
    assert.equal(new Set(dotColors).size, n, `sibling dot colors collided: ${dotColors}`);
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
