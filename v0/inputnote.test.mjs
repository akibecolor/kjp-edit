// SPDX-License-Identifier: MIT
// node --test v0/inputnote.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputNote } from './inputnote.mjs';

test('🚨 未読が残っていたら「送った」と言わずに告げる', () => {
    const r = inputNote({ ok: true, bytes: 12, pending: 4096 });
    assert.equal(r.delivered, false, '滞留しているのに届いたと言っている');
    assert.match(r.note ?? '', /読んでいません/);
    assert.match(r.note ?? '', /4096/, `未読の量を言っていない: ${r.note}`);
});

test('未読が無ければ黙る（余計な行で画面を埋めない）', () => {
    const r = inputNote({ ok: true, bytes: 12, pending: 0 });
    assert.equal(r.delivered, true);
    assert.equal(r.note, null);
});

test('🚨 pending が無い応答を「届いた」と断言しない', () => {
    for (const body of [null, {}, { pending: 'x' }]) {
        const r = inputNote(body);
        assert.equal(r.delivered, false,
            `分からないのに届いたと言っている: ${JSON.stringify(body)}`);
    }
});
