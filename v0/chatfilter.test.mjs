// SPDX-License-Identifier: MIT
// node --test v0/chatfilter.test.mjs
//
// 🚨 **「解釈できない行は捨てずに出す」という宣言を実装と一致させる（#44）。**
//    以前はこの約束を JSON.parse に失敗した行にだけ守っていて、
//    改行で終わらない最後の行と、知らない type を黙って捨てていた。
//    **コメントが警戒していたとおりの形で壊れていた。**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChatFilter, chatGlance } from './chatfilter.mjs';

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

/**
 * 🚨 **feed は投げてはいけない。**
 *
 * `content` が配列でない形が来ると `.filter` が TypeError を投げ、それが購読ループを
 * 抜けて finally の `onState({running:false})` に落ちる。結果、**ペインは「停止」表示
 * なのにセッションは走り続け、そのペインからは止められない**（絶対上限まで）。
 * `transcript.mjs` は同じ形を `Array.isArray` で守っている = この形が来ると知っていた。
 */
test('🚨 壊れた行でも feed が投げない（「停止」表示なのに走り続ける状態を作らない）', () => {
    const broken = [
        { type: 'assistant', message: { content: 'ただの文字列' } },
        { type: 'assistant', message: { content: 42 } },
        { type: 'assistant', message: { content: null } },
        { type: 'assistant', message: {} },
        { type: 'assistant' },
        { type: 'assistant', message: { content: [null, 'x', 7] } },
        { type: 'assistant', message: { content: [{ type: 'text' }] } },
    ];
    for (const r of broken) {
        const c = collect();
        assert.doesNotThrow(() => c.feed(`${JSON.stringify(r)}\n`),
            `feed が投げた: ${JSON.stringify(r)}`);
        // 捨てない（何か1行は出る）
        assert.ok(c.out.length >= 1, `黙って捨てている: ${JSON.stringify(r)}`);
    }
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

/* ===== 監視盤の1行要約（chatGlance） =====
   🚨 監視盤に**生の stream-json** が並ぶと「どれが待っているか」が読めない。
      並列で回すための画面なので、ここが読めないと目的そのものが失われる。
      サーバ側では解釈しない約束なので、解釈はクライアント側（この関数）。 */

test('chatGlance: 会話の最後の応答を1行で返す', () => {
    const g = chatGlance(`${assistant('できました')}`);
    assert.deepEqual(g, { text: 'できました', interpreted: true });
});

test('chatGlance: 応答の終わりが分かる（打ってよい合図）', () => {
    const g = chatGlance(JSON.stringify({ type: 'result', is_error: false }));
    assert.equal(g.interpreted, true);
    assert.match(g.text, /応答おわり/);
});

test('🚨 chatGlance: 本文とツール名の両方を返す（本文だけ落とさない）', () => {
    const g = chatGlance(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '調べます' }, { type: 'tool_use', name: 'Bash' }] },
    }));
    assert.equal(g.interpreted, true);
    // 最後の1行だけにすると `· Bash` になり、**何を言われているかが消える**
    assert.match(g.text, /調べます/, '本文が落ちている（打つべきか判断できない）');
    assert.match(g.text, /Bash/, '走っているツールが見えない');
});

test('🚨 chatGlance: 先頭が切れていても、後ろから見て解釈できた行を使う', () => {
    // サーバは末尾を返すので、1行目は途中から始まる（JSON として壊れている）
    const raw = `e":"assistant"}}\n${assistant('2行目は無傷')}`;
    assert.deepEqual(chatGlance(raw), { text: '2行目は無傷', interpreted: true });
});

test('🚨 chatGlance: 解釈できない出力は生のまま返す（捨てない・空にしない）', () => {
    const g = chatGlance('npm ERR! code ELIFECYCLE');
    assert.deepEqual(g, { text: 'npm ERR! code ELIFECYCLE', interpreted: false });
});

test('🚨 chatGlance: 知らない type も「表示していません」と言う（黙って消さない）', () => {
    const g = chatGlance(JSON.stringify({ type: 'control_response', subtype: 'deny' }));
    assert.equal(g.interpreted, true);
    assert.match(g.text, /control_response\/deny/);
});

test('chatGlance: 何も無いときは空文字（例外を投げない）', () => {
    assert.deepEqual(chatGlance(''), { text: '', interpreted: false });
    assert.deepEqual(chatGlance(null), { text: '', interpreted: false });
});

/* ===== 告知の連続をまとめる（実機で画面が埋まった） =====
   thinking / stream_event はトークンごとに1レコード来るので、
   1件1行の告知だと応答が押し出される。**件数は必ず見せる**。 */

const skip = (type, subtype) => `${JSON.stringify({ type, subtype })}\n`;

test('🚨 同じ告知が連続したら「同上 ×N」でまとめる（件数を隠さない）', () => {
    const c = collect();
    for (let i = 0; i < 40; i++) c.feed(skip('system', 'thinking_tokens'));
    c.feed(assistant('できました'));
    const texts = c.out.map(([, t]) => t);
    // 最初の1件 + まとめ1行 + 応答本文 = 3行（40行にならない）
    assert.equal(texts.length, 3, `行が減っていない: ${JSON.stringify(texts)}`);
    assert.match(texts[0], /system\/thinking_tokens は表示していません/);
    assert.match(texts[1], /×39/, `件数が出ていない: ${texts[1]}`);
    assert.match(texts[2], /できました/);
});

test('🚨 応答本文とツール名はまとめ待ちで遅らせない', () => {
    const c = collect();
    c.feed(skip('stream_event'));
    c.feed(`${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'いま調べます' }, { type: 'tool_use', name: 'Bash' }] },
    })}\n`);
    const texts = c.out.map(([, t]) => t);
    // 告知1件（まとめ無し = extra 0）→ 本文 → ツール名
    assert.match(texts[0], /stream_event/);
    assert.match(texts[1], /いま調べます/);
    assert.match(texts[2], /Bash/);
    assert.equal(texts.length, 3, JSON.stringify(texts));
});

test('🚨 数えたまま黙って終わらない（flush でまとめを出す）', () => {
    const c = collect();
    for (let i = 0; i < 5; i++) c.feed(skip('system', 'thinking_tokens'));
    c.flush();
    const texts = c.out.map(([, t]) => t);
    assert.equal(texts.length, 2, JSON.stringify(texts));
    assert.match(texts[1], /×4/);
});

test('違う告知が挟まったら別の run として数える', () => {
    const c = collect();
    c.feed(skip('system', 'thinking_tokens'));
    c.feed(skip('system', 'thinking_tokens'));
    c.feed(skip('rate_limit_event'));
    c.feed(skip('rate_limit_event'));
    c.flush();
    const texts = c.out.map(([, t]) => t);
    assert.match(texts[0], /thinking_tokens/);
    assert.match(texts[1], /×1/);
    assert.match(texts[2], /rate_limit_event/);
    assert.match(texts[3], /×1/);
    assert.equal(texts.length, 4, JSON.stringify(texts));
});
