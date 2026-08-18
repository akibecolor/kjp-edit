// SPDX-License-Identifier: MIT
// node --test v0/filertabs.test.mjs
//
// レビュー13 が見つけた3件は、どれも **app.html の中にあってテストできなかった**
// ことが原因。ここで固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTabs, restoreSelection, viewFor, tabKey, TAB_LIMIT } from './filertabs.mjs';

/** エージェントが foo.txt をコミットし、そのまま編集を続けている状態 */
const OVERLAP = {
    files: [{ path: 'foo.txt' }, { path: 'bar.txt' }],
    dirtyFiles: ['foo.txt'],
    untracked: ['new.txt'],
};

test('🚨 同じファイルがコミット済みにも未コミットにもあるとき、素タブは base...HEAD を出す', () => {
    // 🚨 **これが壊れると、印と中身が食い違う。**
    //    以前は `dirtyFiles.includes(sel)` だけで振り分けていたので、
    //    素タブを押しても HEAD ↔ 作業ツリーの差分が出て、
    //    **そのファイルのコミット済み差分には二度と辿り着けなかった**。
    //    エージェントがコミットしてから編集を続ける = このツールの中心的な場面で常時起きる。
    assert.equal(viewFor('committed', 'diff', OVERLAP, 'foo.txt'), 'diff',
        '素タブなのに作業ツリー差分を出している（印と中身の食い違い）');
    assert.equal(viewFor('dirty', 'diff', OVERLAP, 'foo.txt'), 'worktree-diff');
    // 重なっていないファイルは今までどおり
    assert.equal(viewFor('committed', 'diff', OVERLAP, 'bar.txt'), 'diff');
    assert.equal(viewFor('untracked', 'diff', OVERLAP, 'new.txt'), 'untracked');
});

test('「全文」を選んでいるときは未コミットでも git の中身を読む（ref の意味を保つ）', () => {
    assert.equal(viewFor('dirty', 'blob', OVERLAP, 'foo.txt'), 'blob');
    assert.equal(viewFor('committed', 'blob', OVERLAP, 'bar.txt'), 'blob');
    // ⚠️ 未追跡は git オブジェクトに無いので「全文」でも読み方は1つ
    assert.equal(viewFor('untracked', 'blob', OVERLAP, 'new.txt'), 'untracked',
        '未追跡を blob として読もうとしている（git には無いので必ず失敗する）');
});

test('種別を知らない遷移（他のカードから）だけ所属で推定する', () => {
    // openDiff() は種別を持たない。そこだけ従来どおりの推定に頼る
    assert.equal(viewFor('auto', 'diff', OVERLAP, 'new.txt'), 'untracked');
    assert.equal(viewFor('auto', 'diff', OVERLAP, 'foo.txt'), 'worktree-diff');
    assert.equal(viewFor('auto', 'diff', OVERLAP, 'bar.txt'), 'diff');
    assert.equal(viewFor(null, 'diff', OVERLAP, 'bar.txt'), 'diff', '未指定も推定に落とす');
    // 壊れた入力で投げない
    assert.equal(viewFor('auto', 'diff', undefined, 'x'), 'diff');
});

test('🚨 復元は種別まで見る（`*` を選んでいると先頭に飛んでいた）', () => {
    const { tabs } = buildTabs(OVERLAP);
    // `*foo.txt` を選んでいる状態で作り直す（15秒ごとの自動更新）
    assert.deepEqual(restoreSelection(tabs, { path: 'foo.txt', kind: 'dirty' }),
        { path: 'foo.txt', kind: 'dirty' },
        '未コミットの選択が保たれていない（自動更新で選択が飛ぶ）');
    assert.deepEqual(restoreSelection(tabs, { path: 'new.txt', kind: 'untracked' }),
        { path: 'new.txt', kind: 'untracked' });
    // 同じパスでも種別が違えばそのタブに戻る
    assert.deepEqual(restoreSelection(tabs, { path: 'foo.txt', kind: 'committed' }),
        { path: 'foo.txt', kind: 'committed' });
    // 消えたら先頭に戻る（前の選択に居座らない）
    assert.deepEqual(restoreSelection(tabs, { path: 'gone.txt', kind: 'dirty' }),
        { path: 'foo.txt', kind: 'committed' });
    // 種別を持たない古い状態は committed として扱う
    assert.deepEqual(restoreSelection(tabs, { path: 'bar.txt' }),
        { path: 'bar.txt', kind: 'committed' });
    assert.equal(restoreSelection([], { path: 'x', kind: 'dirty' }), null);
    assert.equal(restoreSelection([], null), null);
});

test('コミット済み差分が無くても未コミット / 未追跡があればそれを開く（嘘の説明を出さない）', () => {
    // 「base と同じ内容です」と出しながら `*` タブが並ぶ状態を作らない
    const onlyDirty = buildTabs({ files: [], dirtyFiles: ['w.txt'], untracked: [] });
    assert.deepEqual(restoreSelection(onlyDirty.tabs, null), { path: 'w.txt', kind: 'dirty' });
    const onlyNew = buildTabs({ files: [], dirtyFiles: [], untracked: ['n.txt'] });
    assert.deepEqual(restoreSelection(onlyNew.tabs, null), { path: 'n.txt', kind: 'untracked' });
    // 本当に何も無ければ null（そのときだけ「base と同じ内容です」を出してよい）
    assert.equal(restoreSelection(buildTabs({}).tabs, null), null);
});

test('🚨 点灯のキーは title ではない（`*` を押すと素タブが光っていた）', () => {
    const { tabs } = buildTabs(OVERLAP);
    const plain = tabs.find(t => t.kind === 'committed' && t.path === 'foo.txt');
    const star = tabs.find(t => t.kind === 'dirty' && t.path === 'foo.txt');
    assert.notEqual(tabKey(star.kind, star.path), tabKey(plain.kind, plain.path),
        '同じパスの2つのタブが同じキーになっている（押した先と光る先がずれる）');
    // title は人が読むためのもので、同一性の判定には使えない
    assert.notEqual(star.title, star.path, '`*` タブの title には注釈が付く');
    assert.equal(plain.title, plain.path);
    // 印で見分けが付くこと（3種類が同じ見た目にならない）
    assert.equal(plain.label, 'foo.txt');
    assert.equal(star.label, '*foo.txt');
    assert.equal(tabs.find(t => t.kind === 'untracked').label, '+new.txt');
});

test('🚨 省略したら件数を告げる（画面の上限とサーバの上限の両方を足す）', () => {
    // サーバは 50 件で切って残りを dirtyMore で伝える。画面はさらに 6 件で切る。
    // **両方足さないと「全部見えている」と読める表示になる。**
    const many = {
        files: [],
        dirtyFiles: Array.from({ length: 50 }, (_, i) => `d${i}.txt`),
        dirtyMore: 12,                       // サーバが切った残り
        untracked: Array.from({ length: 50 }, (_, i) => `u${i}.txt`),
        untrackedMore: 3,
    };
    const r = buildTabs(many);
    assert.equal(r.tabs.filter(t => t.kind === 'dirty').length, TAB_LIMIT);
    assert.equal(r.hiddenDirty, (50 - TAB_LIMIT) + 12,
        `画面で切った分とサーバで切った分の両方を数えること: ${r.hiddenDirty}`);
    assert.equal(r.hiddenUntracked, (50 - TAB_LIMIT) + 3);
    // 切っていないなら 0（無い告知を出さない）
    const few = buildTabs({ dirtyFiles: ['a'], untracked: ['b'] });
    assert.equal(few.hiddenDirty, 0);
    assert.equal(few.hiddenUntracked, 0);
    // 壊れた payload で投げない
    assert.deepEqual(buildTabs(undefined).tabs, []);
    assert.equal(buildTabs(undefined).hiddenDirty, 0);
});

test('タブの並びは 素 → * → + （見分けの前提）', () => {
    const kinds = buildTabs(OVERLAP).tabs.map(t => t.kind);
    assert.deepEqual(kinds, ['committed', 'committed', 'dirty', 'untracked']);
});
