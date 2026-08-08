// SPDX-License-Identifier: MIT
// node --test v0/precheck.test.mjs
//
// 「調べられなかった」を「衝突なし」と言わないことを固定する（#59）。
// ここが緑でも `allow` に倒れていたら、フックは**黙って通す**ので意味が無い。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, touchedPaths, ALLOW, DENY, ASK } from './precheck.mjs';

const clean = { decided: true, self: null, conflicts: [], busy: [], unknown: [] };

test('precheck: 衝突が無ければ通す', () => {
    const r = decide({ answer: clean, paths: ['a.txt'] });
    assert.equal(r.decision, ALLOW);
});

test('🚨 precheck: デーモンに繋がらないとき allow にしない', () => {
    const r = decide({ answer: null, error: 'ECONNREFUSED', paths: ['a.txt'] });
    assert.equal(r.decision, ASK, '応答が無いのに通している');
    assert.match(r.reason, /確認できません|できませんでした/);
    // 「衝突なし」と読める文言を出さない
    assert.doesNotMatch(r.reason, /衝突はありません|衝突なしです/);
});

test('🚨 precheck: 一部でも判定できなければ allow にしない', () => {
    const r = decide({
        answer: {
            ...clean, decided: false,
            unknown: [{ worktree: '/w/b', why: 'ref を解決できません' }],
        },
        paths: ['a.txt'],
    });
    assert.equal(r.decision, ASK, 'unknown があるのに通している');
    assert.match(r.reason, /ref を解決できません/);
});

test('🚨 precheck: 自分がシーケンサ停止中なら拒否する', () => {
    const r = decide({
        answer: { ...clean, self: { rebasing: true } },
        paths: ['a.txt'],
    });
    assert.equal(r.decision, DENY, 'rebase 停止中の編集を通している');
    assert.match(r.reason, /rebase/);
});

test('precheck: 触るパスが衝突していれば拒否、していなければ通す', () => {
    const answer = {
        ...clean,
        conflicts: [{ path: 'shared.txt', worktree: '/w/b', branch: 'agent-b' }],
    };
    assert.equal(decide({ answer, paths: ['shared.txt'] }).decision, DENY);
    assert.equal(decide({ answer, paths: ['other.txt'] }).decision, ALLOW);
    // パスが分からないときは worktree 全体で見る（絞れない = 通す、にしない）
    assert.equal(decide({ answer, paths: [] }).decision, DENY);
});

test('precheck: 拒否の理由に相手の枝が入る', () => {
    const r = decide({
        answer: { ...clean, conflicts: [{ path: 'x', worktree: '/w/b', branch: 'agent-b' }] },
        paths: ['x'],
    });
    assert.match(r.reason, /agent-b/);
});

test('🚨 touchedPaths: 知らないツールを「パス無し」にしない', () => {
    assert.deepEqual(touchedPaths('Edit', { file_path: 'a.txt' }), ['a.txt']);
    assert.deepEqual(touchedPaths('Write', { file_path: 'b.txt' }), ['b.txt']);
    // null = 「絞り込めない」。空配列（= どこも触らない）と混同しない
    assert.equal(touchedPaths('Bash', { command: 'rm -rf /' }), null);
    assert.equal(touchedPaths('Edit', {}), null);
});
