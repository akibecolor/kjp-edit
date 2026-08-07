// SPDX-License-Identifier: MIT
//
// ペインの配置（利用者がドラッグで決めた並び）の純関数のテスト。
// 実ブラウザで実際にドラッグして測るのは v0/layout-check.mjs（こちらは形の固定）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PANE_HOSTS, MAX_REMEMBERED,
    parseLayout, serializeLayout, hostOf, orderedIds, setHostOrder, pruneLayout,
    isHidden, hidePane, showPane,
} from './panelayout.mjs';

test('parseLayout は壊れた入力でも例外を投げず「配置なし」にする', () => {
    for (const bad of [null, undefined, '', '{', '[]', 'null', '"x"', '3']) {
        const l = parseLayout(bad);
        for (const h of PANE_HOSTS) assert.deepEqual(l[h], [], `${JSON.stringify(bad)} → ${h}`);
    }
    // 知らない入れ物と文字列でない id は落とす（配信元が変わっても壊れないため）
    const l = parseLayout(JSON.stringify({
        left: ['worktrees', 7, '', null, 'filer'], nowhere: ['x'],
    }));
    assert.deepEqual(l.left, ['worktrees', 'filer']);
    assert.equal(l.nowhere, undefined);
});

test('parseLayout は同じ id を1箇所にしか残さない', () => {
    // 2箇所に載っていると hostOf の答えが PANE_HOSTS の順という
    // 無関係な理由で決まる（移動が静かに巻き戻る）
    const l = parseLayout(JSON.stringify({
        left: ['graph', 'graph', 'filer'], right: ['graph'],
    }));
    assert.deepEqual(l.left, ['graph', 'filer']);
    assert.deepEqual(l.right, []);
    assert.equal(hostOf(l, 'graph', 'right'), 'left');
});

test('serializeLayout → parseLayout で往復する', () => {
    const l = setHostOrder(parseLayout(''), 'left', ['filer', 'worktrees']);
    assert.deepEqual(parseLayout(serializeLayout(l)), l);
});

test('hostOf は保存が無いときだけ既定の入れ物を返す', () => {
    const empty = parseLayout('');
    assert.equal(hostOf(empty, 'graph', 'right'), 'right');
    // 🚨 保存された移動先を既定で上書きしたら、自動更新が毎回巻き戻す
    const moved = setHostOrder(empty, 'left', ['graph']);
    assert.equal(hostOf(moved, 'graph', 'right'), 'left');
});

test('orderedIds は保存された順に並べ、知らない id は既定の順で後ろに付ける', () => {
    const l = setHostOrder(parseLayout(''), 'left', ['filer', 'conflicts', 'worktrees']);
    // 呼び出し側が渡す順（既定の並び）とは違う順で返る
    assert.deepEqual(
        orderedIds(l, 'left', ['worktrees', 'conflicts', 'filer']),
        ['filer', 'conflicts', 'worktrees'],
    );
    // 保存に無いものが前に来ると、worktree が1本増えるたびに先頭が入れ替わる
    assert.deepEqual(
        orderedIds(l, 'left', ['worktrees', 'monitor', 'filer', 'agents']),
        ['filer', 'worktrees', 'monitor', 'agents'],
    );
    // 一時的に消えているペインの位置は、他を並べ替えても失われない
    assert.deepEqual(orderedIds(l, 'left', ['worktrees', 'filer']), ['filer', 'worktrees']);
    // 保存が無い入れ物は既定の順のまま
    assert.deepEqual(orderedIds(l, 'right', ['graph', 'x']), ['graph', 'x']);
});

test('setHostOrder は移した id を元の入れ物の記録から消す', () => {
    let l = setHostOrder(parseLayout(''), 'right', ['graph', 'notes']);
    l = setHostOrder(l, 'left', ['graph', 'filer']);
    assert.deepEqual(l.left, ['graph', 'filer']);
    // 消えていないと1つの id が2箇所に載り、列をまたぐ移動が巻き戻る
    assert.deepEqual(l.right, ['notes']);
    assert.equal(hostOf(l, 'graph', 'right'), 'left');
    // 知らない入れ物は無視する（記録を壊さない）
    assert.deepEqual(setHostOrder(l, 'nowhere', ['graph']), l);
});

test('pruneLayout は上限を超えたときだけ、今無い id から捨てる', () => {
    const many = [];
    for (let i = 0; i < MAX_REMEMBERED + 10; i++) many.push(`console-wt-${i}`);
    const l = setHostOrder(parseLayout(''), 'consoles', many);
    const present = new Set(many.slice(-5));
    const kept = pruneLayout(l, present);
    assert.equal(kept.consoles.length, MAX_REMEMBERED);
    // 今あるペインの位置は必ず残る（存在するものを捨てたら並びがその場で崩れる）
    for (const id of present) assert.ok(kept.consoles.includes(id), id);
    // 上限内なら何も捨てない（差分が無い worktree のペインが一時的に消えても位置を覚えている）
    const small = setHostOrder(parseLayout(''), 'left', ['filer', 'worktrees']);
    assert.deepEqual(pruneLayout(small, new Set()), small);
});

/* ===== 閉じる／開く（#57） ===== */

// 🚨 覚えないと 15 秒ごとの更新で戻ってくる（閉じる操作の意味が消える）
test('閉じたことを覚え、開けば戻る', () => {
    let g = parseLayout(null);
    assert.equal(isHidden(g, 'graph'), false);
    g = hidePane(g, 'graph');
    assert.equal(isHidden(g, 'graph'), true);
    g = hidePane(g, 'graph');
    assert.deepEqual(g.closed, ['graph'], '同じ id を溜めている');
    g = showPane(g, 'graph');
    assert.equal(isHidden(g, 'graph'), false);
    // 無いものを開いても壊れない
    assert.deepEqual(showPane(g, 'nope').closed, []);
    // 壊れた入力で投げない
    assert.equal(hidePane(g, ''), g);
    assert.equal(hidePane(g, null), g);
});

// 🚨 保存の形は前方互換（closed が無い古い値も読める）
test('閉じた記憶が保存と読み込みで往復する（古い値も読める）', () => {
    let g = hidePane(parseLayout(null), 'monitor');
    g = setHostOrder(g, 'left', ['worktrees']);
    const back = parseLayout(serializeLayout(g));
    assert.deepEqual(back.closed, ['monitor'], '並べ替えで閉じた記憶が落ちた');
    assert.deepEqual(back.left, ['worktrees']);
    // closed が無い古い保存値
    const old = parseLayout('{"left":["worktrees"],"diffs":[],"consoles":[],"right":[]}');
    assert.deepEqual(old.closed, [], '古い値で壊れている');
    assert.deepEqual(old.left, ['worktrees'], '古い値の並びを捨てている');
    // 壊れた closed
    assert.deepEqual(parseLayout('{"closed":"x"}').closed, []);
    assert.deepEqual(parseLayout('{"closed":[1,"",null,"a","a"]}').closed, ['a']);
});

test('閉じた記憶も上限で削る（今あるものは残す）', () => {
    let g = parseLayout(null);
    for (let i = 0; i < 10; i++) g = hidePane(g, `x${i}`);
    const pruned = pruneLayout(g, new Set(['x0']), 3);
    assert.ok(pruned.closed.length <= 3, `上限を超えている: ${pruned.closed.length}`);
    assert.ok(pruned.closed.includes('x0'), '今あるものを捨てた');
});
