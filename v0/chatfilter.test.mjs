// SPDX-License-Identifier: MIT
// node --test v0/chatfilter.test.mjs
//
// 🚨 **「解釈できない行は捨てずに出す」という宣言を実装と一致させる（#44）。**
//    以前はこの約束を JSON.parse に失敗した行にだけ守っていて、
//    改行で終わらない最後の行と、知らない type を黙って捨てていた。
//    **コメントが警戒していたとおりの形で壊れていた。**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChatFilter } from './chatfilter.mjs';

/** 出力を集める。`[cls, text]` の配列で返す */
function collect() {
    const out = [];
    const f = makeChatFilter((cls, text) => out.push([cls, text]));
    return { ...f, out, text: () => out.map(([, t]) => t).join('') };
}

const assistant = text => `${JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text }] },
})}\n`;

test('応答の本文を出す', () => {
    const c = collect();
    c.feed(assistant('こんにちは'));
    assert.deepEqual(c.out, [['', 'こんにちは\n']]);
});

test('行の途中で切れて届いても組み直す', () => {
    const c = collect();
    const raw = assistant('分割される');
    c.feed(raw.slice(0, 20));
    assert.deepEqual(c.out, [], '不完全な行を出してしまっている');
    c.feed(raw.slice(20));
    assert.deepEqual(c.out, [['', '分割される\n']]);
});

test('🚨 改行で終わらない最後の行を flush で出す（最後の応答が消えない）', () => {
    const c = collect();
    // 完全な JSON だが改行が来ないまま出力が終わる（kill / クラッシュ / 途中で切れた）
    c.feed(assistant('最後の応答').trimEnd());
    assert.deepEqual(c.out, [], '改行前に出してしまっている');
    c.flush();
    assert.equal(c.out.length, 1, `flush で出ていない: ${JSON.stringify(c.out)}`);
    assert.match(c.text(), /最後の応答/, '最後の応答が消えた');
});

test('flush は2回呼んでも重複して出さない', () => {
    const c = collect();
    c.feed('not json at all');
    c.flush();
    c.flush();
    assert.equal(c.out.length, 1, `flush が冪等でない: ${JSON.stringify(c.out)}`);
});

test('flush するものが無ければ何も出さない', () => {
    const c = collect();
    c.feed(assistant('ok'));
    const before = c.out.length;
    c.flush();
    assert.equal(c.out.length, before, '空の行を出している');
});

test('JSON でない行はそのまま出す', () => {
    const c = collect();
    c.feed('not json at all\n');
    assert.deepEqual(c.out, [['', 'not json at all\n']]);
});

test('🚨 知らない type を黙って捨てず、種別を告知する', () => {
    const c = collect();
    c.feed(`${JSON.stringify({
        type: 'control_response', response: { subtype: 'error', error: '許可されていません' },
    })}\n`);
    c.feed(`${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`);
    c.feed(`${JSON.stringify({ type: 'stream_event', event: {} })}\n`);
    assert.equal(c.out.length, 3, `捨てている: ${JSON.stringify(c.out)}`);
    assert.match(c.text(), /control_response/);
    assert.match(c.text(), /system\/compact_boundary/);
    assert.match(c.text(), /stream_event/);
});

test('知らない type の本文は出さない（画面を埋めない）', () => {
    const c = collect();
    c.feed(`${JSON.stringify({ type: 'stream_event', blob: 'X'.repeat(5000) })}\n`);
    assert.ok(c.text().length < 200, `本文を出している: ${c.text().length} 文字`);
    assert.ok(!c.text().includes('XXXXXXXXXX'), '本文が漏れている');
});

test('type が無い行も捨てない', () => {
    const c = collect();
    c.feed('{"foo":1}\n');
    assert.equal(c.out.length, 1, '黙って捨てている');
});

test('result と system/init は専用の表示にする', () => {
    const c = collect();
    c.feed(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abcdef1234' })}\n`);
    c.feed(`${JSON.stringify({ type: 'result', is_error: false })}\n`);
    c.feed(`${JSON.stringify({ type: 'result', is_error: true })}\n`);
    assert.match(c.out[0][1], /abcdef12/);
    assert.equal(c.out[1][0], 'p');
    assert.match(c.out[1][1], /応答おわり/);
    assert.equal(c.out[2][0], 'e');
    assert.match(c.out[2][1], /エラー/);
});

test('tool_use は名前だけ出す（入力は出さない）', () => {
    const c = collect();
    c.feed(`${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { secret: 'S3CRET' } }] },
    })}\n`);
    assert.equal(c.out.length, 1);
    assert.match(c.out[0][1], /Edit/);
    assert.ok(!c.text().includes('S3CRET'), 'ツール入力が漏れている');
});
