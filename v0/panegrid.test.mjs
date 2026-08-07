// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GRID_MAX, GRID_DEFAULT, emptyGrid, parseGrid, serializeGrid,
    cellsOverlap, cellFree, cellOf, autoPlace, moveCell, resizeCell,
    closeCell, openCell, isClosed, resizeGrid, pruneGrid, migrateV1,
    GRID_PRESETS, presetByName, presetOf, applyPreset, mergeCell, splitCell,
} from './panegrid.mjs';

/** 読みやすい形で配置を並べる（失敗メッセージ用） */
const show = g => (g.cells ?? [])
    .map(c => `${c.id}@${c.col},${c.row}${c.cw > 1 || c.ch > 1 ? `(${c.cw}x${c.ch})` : ''}`)
    .sort().join(' ');
const at = (g, id) => cellOf(g, id);

test('重なりの判定（半開区間。辺が接するだけなら重ならない）', () => {
    const a = { col: 1, row: 1, cw: 2, ch: 1 };
    assert.equal(cellsOverlap(a, { col: 2, row: 1, cw: 1, ch: 1 }), true, '2列目が重なっている');
    assert.equal(cellsOverlap(a, { col: 3, row: 1, cw: 1, ch: 1 }), false, '接しているだけ');
    assert.equal(cellsOverlap(a, { col: 1, row: 2, cw: 2, ch: 1 }), false, '下の行');
    assert.equal(cellsOverlap({ col: 1, row: 1, cw: 1, ch: 2 },
        { col: 1, row: 2, cw: 1, ch: 1 }), true, '縦の重なり');
});

test('空きの判定は範囲外を「空いていない」と答える（はみ出しを通さない）', () => {
    const g = { ...emptyGrid(), cells: [{ id: 'a', col: 1, row: 1, cw: 1, ch: 1 }] };
    assert.equal(cellFree(g, { id: 'x', col: 2, row: 1, cw: 1, ch: 1 }), true);
    assert.equal(cellFree(g, { id: 'x', col: 1, row: 1, cw: 1, ch: 1 }), false, '埋まっている');
    // はみ出し（3列のグリッドで col=3 から cw=2）
    assert.equal(cellFree(g, { id: 'x', col: 3, row: 1, cw: 2, ch: 1 }), false, 'はみ出しを通した');
    assert.equal(cellFree(g, { id: 'x', col: 0, row: 1, cw: 1, ch: 1 }), false, '1 始まりでない');
    // 自分自身は無視する（広げる判定で使う）
    assert.equal(cellFree(g, { id: 'a', col: 1, row: 1, cw: 2, ch: 1 }, 'a'), true);
});

test('自動配置は左上から読み順に置き、入り切らない分を overflow で返す', () => {
    const { grid, overflow } = autoPlace(emptyGrid(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    // 既定は 3x2 = 6 セル
    assert.equal(grid.cells.length, 6, show(grid));
    assert.deepEqual(overflow, ['g'], '入り切らない分を黙って捨てている');
    assert.deepEqual(at(grid, 'a'), { id: 'a', col: 1, row: 1, cw: 1, ch: 1 });
    assert.deepEqual(at(grid, 'd'), { id: 'd', col: 1, row: 2, cw: 1, ch: 1 });
});

test('自動配置は既にある配置を動かさない（利用者が置いた位置を巻き戻さない）', () => {
    const g = { ...emptyGrid(), cells: [{ id: 'b', col: 3, row: 2, cw: 1, ch: 1 }] };
    const { grid } = autoPlace(g, ['a', 'b']);
    assert.deepEqual(at(grid, 'b'), { id: 'b', col: 3, row: 2, cw: 1, ch: 1 }, '動かしている');
    assert.deepEqual(at(grid, 'a'), { id: 'a', col: 1, row: 1, cw: 1, ch: 1 });
    // 🚨 **件数も測る。** `find` は最初の一致を返すので、同じ id の2枚目が
    //    後ろに積まれても「動いていない」と読めてしまう
    //    （CLAUDE.md「同一性が保たれているだけでは作り直しを見抜けない」。
    //     実際にこの形で変異が SURVIVED した）。
    assert.equal(grid.cells.filter(c => c.id === 'b').length, 1,
        `同じ id のセルが増えている: ${show(grid)}`);
    assert.equal(grid.cells.length, 2, `セルが増えている: ${show(grid)}`);
});

// 🚨 存在しなくなった worktree の位置を失わない（v1 の orderedIds と同じ方針）
test('自動配置は「今存在しない id」の配置を残す', () => {
    const g = { ...emptyGrid(), cells: [{ id: 'gone', col: 1, row: 1, cw: 1, ch: 1 }] };
    const { grid } = autoPlace(g, ['a']);
    assert.ok(at(grid, 'gone'), '一時的に消えたペインの位置を捨てている');
    assert.deepEqual(at(grid, 'a'), { id: 'a', col: 2, row: 1, cw: 1, ch: 1 });
});

test('広げると2セル分を占め、その先に他が居るなら断る', () => {
    const { grid } = autoPlace(emptyGrid(), ['a', 'b']);
    const no = resizeCell(grid, 'a', 2, 1);
    assert.equal(no.ok, false, 'b が居るのに広げた');
    assert.match(no.why, /別のペイン/);
    assert.deepEqual(no.grid, grid, '断ったのに配置を変えている');

    const freed = closeCell(grid, 'b');
    const yes = resizeCell(freed, 'a', 2, 1);
    assert.equal(yes.ok, true, yes.why ?? '');
    assert.deepEqual(at(yes.grid, 'a'), { id: 'a', col: 1, row: 1, cw: 2, ch: 1 });
    // 縦も同じ
    const tall = resizeCell(yes.grid, 'a', 2, 2);
    assert.equal(tall.ok, true, tall.why ?? '');
    assert.equal(at(tall.grid, 'a').ch, 2);
});

test('広げてグリッドの外に出るなら断る（黙って縮めない）', () => {
    const { grid } = autoPlace(emptyGrid(), ['a']);
    const moved = moveCell(grid, 'a', { col: 3, row: 1 });
    assert.equal(moved.ok, true);
    const over = resizeCell(moved.grid, 'a', 2, 1);
    assert.equal(over.ok, false, '3列目から横2セルは外に出る');
    assert.match(over.why, /はみ出/);
    assert.equal(at(over.grid, 'a').cw, 1, '断ったのに大きさが変わっている');
});

test('移動: 空きへは動く。同じ大きさの相手とは入れ替える', () => {
    const { grid } = autoPlace(emptyGrid(), ['a', 'b']);
    const free = moveCell(grid, 'a', { col: 3, row: 2 });
    assert.equal(free.ok, true, free.why ?? '');
    assert.deepEqual(at(free.grid, 'a'), { id: 'a', col: 3, row: 2, cw: 1, ch: 1 });

    const swap = moveCell(grid, 'a', { col: 2, row: 1 });
    assert.equal(swap.ok, true, swap.why ?? '');
    assert.deepEqual(at(swap.grid, 'a'), { id: 'a', col: 2, row: 1, cw: 1, ch: 1 });
    assert.deepEqual(at(swap.grid, 'b'), { id: 'b', col: 1, row: 1, cw: 1, ch: 1 },
        '入れ替えた相手が元の位置に来ていない');
});

// 🚨 2枚が同じセルに描かれると、片方が見えないまま走り続ける（観測ツールとして最悪）
test('移動: 大きさの違う相手・複数に重なる移動は断る', () => {
    let g = autoPlace(emptyGrid(), ['a', 'b', 'c']).grid;
    g = closeCell(g, 'c');
    g = resizeCell(g, 'b', 1, 2).grid;   // b を縦2セルに
    const no = moveCell(g, 'a', { col: 2, row: 1 });
    assert.equal(no.ok, false, '大きさの違う相手に重ねた');
    assert.deepEqual(no.grid, g, '断ったのに配置を変えている');

    // 横2セル分の移動が2枚に重なる形（x を y と z の上に重ねようとする）
    const h = autoPlace(emptyGrid(), ['x', 'y', 'z']).grid;
    const two = moveCell(h, 'x', { col: 2, row: 1, cw: 2, ch: 1 });
    assert.equal(two.ok, false, '複数に重なる移動を通した');
    assert.deepEqual(two.grid, h, '断ったのに配置を変えている');
});

test('移動: 配置されていない id は断る（存在しないものを動かさない）', () => {
    const g = emptyGrid();
    const r = moveCell(g, 'nope', { col: 1, row: 1 });
    assert.equal(r.ok, false);
    assert.match(r.why, /配置されていません/);
});

// 🚨 閉じたものが自動で戻ってくると、閉じる操作の意味が消える
test('閉じたペインは自動配置で戻ってこない。開けば戻る', () => {
    const { grid } = autoPlace(emptyGrid(), ['a', 'b']);
    const closed = closeCell(grid, 'b');
    assert.equal(isClosed(closed, 'b'), true);
    assert.equal(at(closed, 'b'), null, '閉じたのに配置が残っている');

    const again = autoPlace(closed, ['a', 'b']);
    assert.equal(at(again.grid, 'b'), null, '閉じたものが自動で戻ってきた');
    assert.deepEqual(again.overflow, [], '閉じたものを「入り切らない」と数えている');

    const opened = autoPlace(openCell(closed, 'b'), ['a', 'b']);
    assert.ok(at(opened.grid, 'b'), '開いても戻ってこない');
});

test('閉じるを2回呼んでも記録は1つ（同じ id を溜めない）', () => {
    let g = autoPlace(emptyGrid(), ['a']).grid;
    g = closeCell(g, 'a');
    g = closeCell(g, 'a');
    assert.deepEqual(g.closed, ['a']);
});

test('グリッドを縮めるとはみ出す分を dropped で返す（黙って消さない）', () => {
    const { grid } = autoPlace(emptyGrid(), ['a', 'b', 'c', 'd', 'e', 'f']);
    const { grid: small, dropped } = resizeGrid(grid, 2, 2);
    assert.deepEqual(dropped.sort(), ['c', 'f'], `落ちた分が違う: ${show(grid)}`);
    assert.equal(small.cols, 2);
    assert.equal(small.cells.length, 4);
    // 落ちた分は自動配置で戻る先が無ければ overflow として告知される
    const after = autoPlace(small, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(after.overflow.sort(), ['c', 'f'], '落ちた分を黙って消している');
});

test('グリッドの大きさは 1〜4 の外を受け付けない（値は黙って捨てない = 変えない）', () => {
    const g = emptyGrid();
    for (const bad of [0, -1, GRID_MAX + 1, 1.5, NaN, '3', null, undefined]) {
        const r = resizeGrid(g, bad, 2);
        assert.equal(r.grid.cols, g.cols, `cols=${JSON.stringify(bad)} を通した`);
    }
    assert.equal(resizeGrid(g, 4, 4).grid.cols, 4);
    assert.equal(resizeGrid(g, 4, 4).grid.rows, 4);
});

test('保存と読み込みが往復する', () => {
    let g = autoPlace(emptyGrid(), ['a', 'b', 'c']).grid;
    g = closeCell(g, 'c');
    g = resizeCell(g, 'a', 1, 2).grid;
    const back = parseGrid(serializeGrid(g));
    assert.equal(serializeGrid(back), serializeGrid(g));
    assert.deepEqual(back.closed, ['c']);
});

// 🚨 ここで throw するとモジュールの評価が止まり、ページが真っ白になる
test('壊れた保存値は「配置なし」にする（例外にしない）', () => {
    for (const bad of ['', 'null', '{', '[]', '{"v":1}', '{"v":2,"cells":"x"}',
        undefined, null, 42, '{"v":2,"cols":99,"rows":99}']) {
        const g = parseGrid(bad);
        assert.equal(g.v, 2, JSON.stringify(bad));
        assert.ok(g.cols >= 1 && g.cols <= GRID_MAX, `cols が範囲外: ${g.cols}`);
        assert.ok(Array.isArray(g.cells), JSON.stringify(bad));
    }
    // 既定に落ちる（3x2）
    assert.deepEqual(
        { cols: parseGrid('{"v":2,"cols":99,"rows":0}').cols, rows: parseGrid('{"v":2,"cols":99,"rows":0}').rows },
        GRID_DEFAULT);
});

// 🚨 同じ id が2度出ていると「どちらが本物か」が配列順という無関係な理由で決まる
test('読み込み: 重複した id と重なるセルは後から来た方を落とす', () => {
    const raw = JSON.stringify({
        v: 2, cols: 3, rows: 2,
        cells: [
            { id: 'a', col: 1, row: 1, cw: 1, ch: 1 },
            { id: 'a', col: 2, row: 1, cw: 1, ch: 1 },   // 重複
            { id: 'b', col: 1, row: 1, cw: 1, ch: 1 },   // 重なり
            { id: 'c', col: 3, row: 1, cw: 1, ch: 1 },
            { id: 'd', col: 3, row: 1, cw: 9, ch: 1 },   // はみ出し
        ],
    });
    const g = parseGrid(raw);
    assert.deepEqual(show(g), 'a@1,1 c@3,1', show(g));
    // 落ちた分は配置なし = 自動配置で空きに戻る（消えるのではない）
    const { grid } = autoPlace(g, ['a', 'b', 'c', 'd']);
    assert.ok(at(grid, 'b'), '落とした id が配置されない');
    assert.ok(at(grid, 'd'), '落とした id が配置されない');
});

test('覚えている配置に上限がある（今あるものは残す）', () => {
    const cells = [];
    for (let i = 0; i < 10; i++) cells.push({ id: `x${i}`, col: 1, row: 1, cw: 1, ch: 1 });
    const g = { ...emptyGrid(), cells, closed: ['c1', 'c2', 'c3'] };
    const pruned = pruneGrid(g, new Set(['x0', 'c1']), 5);
    assert.ok(pruned.cells.length + pruned.closed.length <= 5,
        `上限を超えている: ${pruned.cells.length + pruned.closed.length}`);
    assert.ok(pruned.cells.some(c => c.id === 'x0'), '今あるものを捨てた');
    assert.ok(pruned.closed.includes('c1'), '今あるものの「閉じた」を捨てた');
    // 上限内なら何もしない（同じ参照を返す = 無駄な保存を起こさない）
    const small = { ...emptyGrid(), cells: [{ id: 'a', col: 1, row: 1, cw: 1, ch: 1 }] };
    assert.equal(pruneGrid(small, new Set(['a']), 5), small);
});

// 🚨 移行を通さないと、利用者が移した位置が1回全部消える
test('v1 の配置をグリッドへ移す（並びを黙って捨てない）', () => {
    const v1 = {
        left: ['worktrees', 'agents'],
        diffs: ['diff-a'],
        consoles: ['console-a'],
        right: ['graph'],
    };
    const g = migrateV1(v1);
    assert.deepEqual(at(g, 'worktrees'), { id: 'worktrees', col: 1, row: 1, cw: 1, ch: 1 });
    assert.deepEqual(at(g, 'agents'), { id: 'agents', col: 1, row: 2, cw: 1, ch: 1 });
    assert.deepEqual(at(g, 'diff-a'), { id: 'diff-a', col: 2, row: 1, cw: 1, ch: 1 });
    assert.deepEqual(at(g, 'console-a'), { id: 'console-a', col: 2, row: 2, cw: 1, ch: 1 });
    assert.deepEqual(at(g, 'graph'), { id: 'graph', col: 3, row: 1, cw: 1, ch: 1 });
    // 入り切らない分は配置しない（autoPlace / overflow が面倒を見る）
    const many = migrateV1({ left: ['a', 'b', 'c', 'd'], diffs: [], consoles: [], right: [] });
    assert.equal(many.cells.length, 2, `3x2 の1列に3枚以上入れている: ${show(many)}`);
    // 壊れた入力で投げない
    assert.deepEqual(migrateV1(null).cells, []);
    assert.deepEqual(migrateV1({ left: 'x' }).cells, []);
});

/* ===== パターン（プリセット）と結合（#57） ===== */

test('パターンの一覧は名前と大きさが整合している（名前は保存に載るので変えない）', () => {
    for (const p of GRID_PRESETS) {
        const [rows, cols] = p.name.split('x').map(Number);
        assert.equal(p.rows, rows, `${p.name} の行数が名前と違う`);
        assert.equal(p.cols, cols, `${p.name} の列数が名前と違う`);
        assert.ok(p.cols >= 1 && p.cols <= GRID_MAX, p.name);
        assert.ok(p.rows >= 1 && p.rows <= GRID_MAX, p.name);
        assert.ok(p.label && typeof p.label === 'string', `${p.name} に表示名が無い`);
    }
    // 指定された形が全部ある（1枚 / 1行2列 / 1行3列 / 2×2 … 4×4）
    const names = GRID_PRESETS.map(p => p.name);
    for (const want of ['1x1', '1x2', '1x3', '2x2', '3x3', '4x4']) {
        assert.ok(names.includes(want), `${want} が無い`);
    }
    assert.equal(presetByName('9x9'), null, '知らない名前を通した');
});

// 🚨 順序を捨てると「形を変えたらペインが総入れ替え」になり、どれがどれか分からない
// 🚨 **ids の順ではなく「今の配置の読み順」を保つこと**を測る。
//    両方を同じ順で渡すと、配置を捨てる実装でも通ってしまう
//    （最初そう書いて変異が SURVIVED した）。**入れ替えてから**測る。
test('パターンを当てても読み順（左上から）を保つ', () => {
    let g = autoPlace(emptyGrid(), ['a', 'b', 'c', 'd', 'e', 'f']).grid;
    // a と b を入れ替える（= 配置の読み順は b, a, … になる）
    g = moveCell(g, 'a', { col: 2, row: 1 }).grid;
    assert.deepEqual(at(g, 'b'), { id: 'b', col: 1, row: 1, cw: 1, ch: 1 }, '前提が崩れている');
    // ids は元の順（a が先）で渡す。**配置の順が勝つ**のが正しい
    const r = applyPreset(g, '4x4', ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(at(r.grid, 'b'), { id: 'b', col: 1, row: 1, cw: 1, ch: 1 },
        `配置の読み順を捨てて ids の順で並べ直している: ${show(r.grid)}`);
    assert.deepEqual(at(r.grid, 'a'), { id: 'a', col: 2, row: 1, cw: 1, ch: 1 }, show(r.grid));
    assert.deepEqual(at(r.grid, 'e'), { id: 'e', col: 1, row: 2, cw: 1, ch: 1 }, show(r.grid));
    assert.deepEqual(r.overflow, [], '4×4 なら 6 枚は入る');
    assert.equal(presetOf(r.grid), '4x4');
});

test('狭いパターンでは入り切らない分を overflow で返す（黙って捨てない）', () => {
    const g = autoPlace(emptyGrid(), ['a', 'b', 'c', 'd']).grid;
    const one = applyPreset(g, '1x1', ['a', 'b', 'c', 'd']);
    assert.equal(one.grid.cells.length, 1, show(one.grid));
    assert.deepEqual(one.overflow, ['b', 'c', 'd'], '溢れを告げていない');
    const two = applyPreset(g, '1x2', ['a', 'b', 'c', 'd']);
    assert.equal(two.grid.cells.length, 2);
    assert.deepEqual(two.overflow, ['c', 'd']);
});

// ⚠️ 結合は新しい形に入るとは限らないので落とすが、黙って落とさない
test('パターンを当てると結合は解け、解いた件数を返す', () => {
    let g = autoPlace(emptyGrid(), ['a', 'b', 'c']).grid;
    g = closeCell(g, 'b');
    g = resizeCell(g, 'a', 2, 1).grid;
    assert.equal(at(g, 'a').cw, 2);
    const r = applyPreset(g, '2x2', ['a', 'b', 'c']);
    assert.equal(r.unmerged, 1, '解いた件数を告げていない');
    assert.equal(at(r.grid, 'a').cw, 1, '結合が残っている（新しい形に入らないかもしれない）');
    // 閉じた記憶は保つ（形を変えたら閉じたものが戻ってくる、を作らない）
    assert.deepEqual(r.grid.closed, ['b']);
});

test('知らないパターン名は何も変えない（黙って別の形にしない）', () => {
    const g = autoPlace(emptyGrid(), ['a']).grid;
    const r = applyPreset(g, 'nope', ['a']);
    assert.equal(r.grid, g);
    assert.deepEqual(r.overflow, []);
});

// 🚨 **実機の指摘で挙動を変えた**: 隣が埋まっていても押し出して広げる。
//    以前は「空いていなければ断る」だったので、画面が埋まっている普通の状態では
//    常に断られ、「拡張のボタンが効かない」ように見えた。
//    押し出した相手は配置から外れ、autoPlace が空きに置く（無ければ溢れて告知）。
test('結合は隣を占め、埋まっていれば押し出す。解くのは必ず通る', () => {
    let g = applyPreset(autoPlace(emptyGrid(), ['a', 'b']).grid, '2x2', ['a', 'b']).grid;
    // b が右に居ても**押し出して**広がる（押し出した id を返す）
    const push = mergeCell(g, 'a', 'right');
    assert.equal(push.ok, true, push.why ?? '');
    assert.deepEqual(push.displaced, ['b'], '押し出した相手を返していない');
    assert.equal(at(push.grid, 'a').cw, 2, show(push.grid));
    assert.equal(at(push.grid, 'b'), null, '押し出した相手の配置が残っている（重なる）');
    // 押し出した相手は空きに置き直される（2×2 なら空きがある）
    const replaced = autoPlace(push.grid, ['a', 'b']);
    assert.ok(at(replaced.grid, 'b'), '押し出した相手が置き直されない');
    assert.deepEqual(replaced.overflow, [], show(replaced.grid));
    // 下は空いているので通る
    const down = mergeCell(g, 'a', 'down');
    assert.equal(down.ok, true, down.why ?? '');
    assert.deepEqual(at(down.grid, 'a'), { id: 'a', col: 1, row: 1, cw: 1, ch: 2 });
    // 解くのは必ず通る（縮めるだけ）
    const back = splitCell(down.grid, 'a');
    assert.equal(back.ok, true, back.why ?? '');
    assert.deepEqual(at(back.grid, 'a'), { id: 'a', col: 1, row: 1, cw: 1, ch: 1 });
    // 知らない方向は断る（黙って別の方向に広げない）
    const bad = mergeCell(g, 'a', 'sideways');
    assert.equal(bad.ok, false);
    assert.match(bad.why, /知らない方向/);
});
