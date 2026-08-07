// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTests, detailLines } from './testsummary.mjs';

const NL = String.fromCharCode(10);

/** `node --test` の実出力に合わせた断片（実際の形をそのまま使う） */
const sample = [
    '✔ 何かの検査 (1.2ms)',
    '﹣ 🚨 終了: SIGHUP（端末を閉じる）でも子を置き去りにしない (0.2018ms) # Windows は process.kill でハンドラが走らない',
    '﹣ 🔒 write: シンボリックリンクは編集しない (301.51ms) # symlink を作れないので測れません: EPERM',
    '✖ 壊れている検査 (5ms)',
    '  AssertionError [ERR_ASSERTION]: 期待と違う',
    'ℹ tests 4',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 2',
    'ℹ todo 0',
].join(NL);

// 🚨 #52 の本体。要約が skipped を出さないので、
//    「このプラットフォームでは測っていない検査」が緑と区別できなかった。
test('skipped を数える（測っていない検査を緑と読ませない）', () => {
    const s = summarizeTests(sample);
    assert.equal(s.pass, 1);
    assert.equal(s.fail, 1);
    assert.equal(s.skipped, 2, 'skipped を数えていない（緑と区別できない）');
    assert.equal(s.todo, 0);
});

test('どれが飛ばされたかも返す（件数だけでは何が未検証か分からない）', () => {
    const s = summarizeTests(sample);
    assert.equal(s.skippedNames.length, 2, `飛ばした検査名が取れていない: ${JSON.stringify(s.skippedNames)}`);
    assert.match(s.skippedNames[0], /SIGHUP/);
    assert.match(s.skippedNames[1], /シンボリックリンク/);
    // ⚠️ 理由（# の後ろ）は名前に混ぜない（一覧が読めなくなる）
    assert.equal(s.skippedNames[0].includes('#'), false, `名前に理由が混ざっている: ${s.skippedNames[0]}`);
});

test('失敗は名前と原因を1件ずつ返す', () => {
    const s = summarizeTests(sample);
    assert.equal(s.failing.length, 1);
    assert.equal(s.failing[0].name, '壊れている検査');
    assert.match(s.failing[0].cause, /AssertionError/);
});

// 🚨 `node --test` は ✖ を2回出す（インラインと末尾の要約）。
test('同じ失敗を二重に数えない', () => {
    const doubled = [
        '✖ 同じ検査 (5ms)',
        '  AssertionError [ERR_ASSERTION]: 理由',
        '✖ failing tests:',
        '✖ 同じ検査 (5ms)',
        'ℹ pass 0',
        'ℹ fail 1',
    ].join(NL);
    const s = summarizeTests(doubled);
    assert.equal(s.failing.length, 1, `重複排除できていない: ${JSON.stringify(s.failing)}`);
    assert.match(s.failing[0].cause, /理由/, '原因が取れている方を残していない');
});

test('要約が出ていない（途中で落ちた）ときも 0 を返して落ちない', () => {
    const s = summarizeTests('Segmentation fault');
    assert.equal(s.pass, 0);
    assert.equal(s.fail, 0);
    assert.equal(s.skipped, 0);
    assert.deepEqual(s.skippedNames, []);
    assert.deepEqual(s.failing, []);
});

// 🚨 打ち切りのときは**末尾**が要る（先頭は起動時の案内で埋まる）。
test('detailLines: 打ち切りは末尾、通常は先頭', () => {
    const text = ['1行目', '2行目', '', '3行目', '4行目'].join(NL);
    assert.deepEqual(detailLines(text, 2, true), ['3行目', '4行目']);
    assert.deepEqual(detailLines(text, 2, false), ['1行目', '2行目']);
    assert.deepEqual(detailLines('', 3, true), []);
    assert.deepEqual(detailLines(null, 3, false), []);
});
