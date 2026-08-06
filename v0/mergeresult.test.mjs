// SPDX-License-Identifier: MIT
// node --test v0/mergeresult.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOutcome } from './mergeresult.mjs';

test('成功は成功として出し、画面を数え直す', () => {
    const r = mergeOutcome(200, { ok: true, conflicted: false, warning: null });
    assert.equal(r.ok, true);
    assert.equal(r.sticky, null);
    assert.equal(r.reload, true);
});

test('予測が外れて衝突状態になったら消えない告知に回す', () => {
    const r = mergeOutcome(200, {
        ok: true, conflicted: true, warning: '⚠ 衝突しないと予測したのに衝突状態になりました',
    });
    assert.equal(r.ok, true);
    assert.match(r.sticky, /衝突/);
    assert.match(r.message, /衝突状態/);
});

/**
 * 🚨 8回目のレビュー（SERIOUS）: merge が途中で失敗すると MERGE_HEAD と
 *    staged 変更が残るのに、画面は「拒否しました」と言って clean のままだった。
 */
test('半端な状態が残ったら、消えない告知に回して数え直す', () => {
    const r = mergeOutcome(409, {
        error: '取り込みは完了しませんでした。作業ツリーに半端な状態が残っています（MERGE_HEAD あり / 変更 1 件）',
        leftover: { counted: true, dirty: true, merging: true, changed: 1, unmerged: 0 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reload, true, '失敗でも数え直さないと画面が clean のまま残る');
    assert.ok(r.sticky, '半端な状態の告知が再描画で消える場所に出ている');
    assert.match(r.sticky, /半端な状態/);
});

test('数え直せなかったときも消えない告知に回す（分からないなら分からないと言う）', () => {
    const r = mergeOutcome(409, {
        error: '取り込みが失敗し、そのあとの作業ツリーの状態を数え直せませんでした',
        leftover: { counted: false, dirty: null, merging: null, changed: null, unmerged: null },
    });
    assert.equal(r.ok, false);
    assert.ok(r.sticky, '「分からない」を黙って消してはいけない');
});

test('手前の門で断られただけなら、消えない告知は残さない', () => {
    // dirty / driver / 衝突の予測で断られた場合は git merge を走らせていない
    for (const body of [
        { error: '未コミットの変更が 2 件あります' },
        { error: '衝突します: shared.txt' },
        { error: 'ref が不正です: --force' },
    ]) {
        const r = mergeOutcome(409, body);
        assert.equal(r.ok, false);
        assert.equal(r.sticky, null, `無用な警告を残している: ${body.error}`);
        assert.equal(r.message, body.error);
        assert.equal(r.reload, true);
    }
});

test('本文が読めなくても落ちない', () => {
    const r = mergeOutcome(500, null);
    assert.equal(r.ok, false);
    assert.equal(r.message, 'HTTP 500');
    assert.equal(r.sticky, null);
});

test('leftover が clean と言っているなら告知を残さない', () => {
    const r = mergeOutcome(409, {
        error: 'git が取り込みを拒否しました（作業ツリーは元のままです）',
        leftover: { counted: true, dirty: false, merging: false, changed: 0, unmerged: 0 },
    });
    assert.equal(r.sticky, null);
});
