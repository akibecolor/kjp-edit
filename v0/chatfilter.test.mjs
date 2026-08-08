// SPDX-License-Identifier: MIT
// node --test v0/chatfilter.test.mjs
//
// 🚨 **「解釈できない行は捨てずに出す」という宣言を実装と一致させる（#44）。**
//    以前はこの約束を JSON.parse に失敗した行にだけ守っていて、
//    改行で終わらない最後の行と、知らない type を黙って捨てていた。
//    **コメントが警戒していたとおりの形で壊れていた。**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChatFilter, chatGlance, chatInputText, chatRecordLines } from './chatfilter.mjs';

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
    assert.deepEqual(g, { text: 'できました', interpreted: true, writing: false });
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
    assert.deepEqual(chatGlance(raw), { text: '2行目は無傷', interpreted: true, writing: false });
});

test('🚨 chatGlance: 解釈できない出力は生のまま返す（捨てない・空にしない）', () => {
    const g = chatGlance('npm ERR! code ELIFECYCLE');
    assert.deepEqual(g, { text: 'npm ERR! code ELIFECYCLE', interpreted: false, writing: false });
});

/* 🚨 8回目のレビューの SERIOUS。**JSON 行 + 末尾の生テキスト**という混在形が
      テストに1件も無く、`chatGlance` は末尾の非 JSON 行を無条件に飛ばして
      **数分前の応答を「最後の出力」として返していた**（しかも interpreted:true
      なので「← 解釈できない行」も付かない = 黙って捨てている）。
      会話が死ぬ / 殺されるときに最後に来るのは必ず生テキストなので、
      **止まったのに動いているように見える**（この盤で一番効く嘘）。 */

test('🚨 chatGlance: 末尾の非 JSON 行を飛ばして古い応答を出さない（停止が消える）', () => {
    const raw = `${assistant('これは3分前の応答')}⚠ 停止を要求されました\n`;
    const g = chatGlance(raw);
    assert.equal(g.text, '⚠ 停止を要求されました',
        `末尾の行を捨てて前の応答を「最後の出力」にしている: ${JSON.stringify(g)}`);
    assert.equal(g.interpreted, false,
        '解釈できなかったのに interpreted:true（「← 解釈できない行」が付かない）');
});

test('🚨 chatGlance: 末尾が claude の stderr のときもそれを出す', () => {
    // 実測の形（会話モードの子が死ぬときに最後に来る行）
    const raw = `${assistant('ああああ')}Error parsing streaming input line: boom\n`;
    const g = chatGlance(raw);
    assert.match(g.text, /Error parsing streaming input line/,
        '終わった理由が画面から消える');
    assert.equal(g.interpreted, false);
});

test('🚨 chatGlance: 先頭が切れていて末尾も生テキストなら、末尾を出す', () => {
    // 「先頭切れの救済」と「末尾を捨てない」は両立する（救済は先頭の1行だけ）
    const raw = `e":"assistant"}}\n${assistant('途中の応答')}npm ERR! code ELIFECYCLE\n`;
    assert.deepEqual(chatGlance(raw),
        { text: 'npm ERR! code ELIFECYCLE', interpreted: false, writing: false });
});

/* 🚨 9回目のレビュー / #51: **応答を書いている最中**の断片で本文が隠れていた。
   サーバの `lastOutput()` はその瞬間までの生の出力を返すので、
   ストリーム中の最後の行は改行で終わらない JSON の断片になる。
   以前はそれを「末尾の解釈できない行」としてそのまま出していたので、
   **並列で回して見ている最中（この盤を一番見たいとき）に限って
   直前の応答が読めなかった。** 断片は飛ばすが、飛ばしたことは告げる。 */

test('🚨 chatGlance: 書き込み中の断片で本文を隠さない（飛ばしたことは告げる）', () => {
    const partial = '{"type":"assistant","message":{"content":[{"type":"te';
    const g = chatGlance(`${assistant('直前の応答です')}${partial}`);
    assert.equal(g.text, '直前の応答です',
        `書き込み中の断片が本文を隠している: ${JSON.stringify(g)}`);
    assert.equal(g.interpreted, true);
    assert.equal(g.writing, true, '断片を飛ばしたことを告げていない（黙って捨てている）');
});

test('🚨 chatGlance: 改行で終わる非 JSON 行は「書き込み中」にしない（停止の告知を消さない）', () => {
    const g = chatGlance(`${assistant('前の応答')}⚠ 停止を要求されました
`);
    assert.equal(g.text, '⚠ 停止を要求されました', '完全な1行を書き込み中と誤判定している');
    assert.equal(g.writing, false);
});

test('chatGlance: 断片しか無いなら断片を出す（空にしない）', () => {
    const g = chatGlance('{"type":"assi');
    assert.equal(g.text, '{"type":"assi', '断片しか無いのに空にしている');
    assert.equal(g.interpreted, false);
});
test('🚨 chatGlance: 知らない type も「表示していません」と言う（黙って消さない）', () => {
    const g = chatGlance(JSON.stringify({ type: 'control_response', subtype: 'deny' }));
    assert.equal(g.interpreted, true);
    assert.match(g.text, /control_response\/deny/);
});

test('chatGlance: 何も無いときは空文字（例外を投げない）', () => {
    assert.deepEqual(chatGlance(''), { text: '', interpreted: false, writing: false });
    assert.deepEqual(chatGlance(null), { text: '', interpreted: false, writing: false });
});

/* ===== 告知の連続をまとめる（実機で画面が埋まった） =====
   thinking / stream_event はトークンごとに1レコード来るので、
   1件1行の告知だと応答が押し出される。**件数は必ず見せる**。 */

const skip = (type, subtype) => `${JSON.stringify({ type, subtype })}\n`;

test('🚨 同じ告知は種別ごとに1回だけ出し、残りは数える（件数を隠さない）', () => {
    const c = collect();
    for (let i = 0; i < 40; i++) c.feed(skip('system', 'thinking_tokens'));
    c.feed(assistant('できました'));
    let texts = c.out.map(([, t]) => t);
    // 告知1行 + 応答本文 = 2行（40行にならない）
    assert.equal(texts.length, 2, `行が減っていない: ${JSON.stringify(texts)}`);
    assert.match(texts[0], /system\/thinking_tokens は表示していません/);
    assert.match(texts[0], /数えるだけ/, '以降を数えることを言っていない');
    assert.match(texts[1], /できました/);
    // 数えたまま黙って終わらない
    c.flush();
    texts = c.out.map(([, t]) => t);
    assert.match(texts[texts.length - 1], /×39/, `件数が出ていない: ${texts[texts.length - 1]}`);
});

/**
 * 🚨 **実機で指摘された形の回帰テスト。**
 *
 * `user`（`--replay-user-messages` の再送）と `rate_limit_event` は
 * **本物の応答の合間に挟まる**ので「連続をまとめる」では減らず、
 * 会話の間に告知が刺し込まれ続けていた
 * （「チャットの構造データが流れてくるのは、見せ方として不要」）。
 */
test('🚨 応答の合間に挟まる告知が繰り返し出ない（会話が読める）', () => {
    const c = collect();
    for (let i = 0; i < 5; i++) {
        c.feed(skip('user'));
        c.feed(assistant(`応答${i}`));
        c.feed(skip('rate_limit_event'));
    }
    const texts = c.out.map(([, t]) => t);
    const notices = texts.filter(t => /表示していません/.test(t));
    assert.equal(notices.length, 2,
        `告知が繰り返し出ている（種別ごとに1回のはず）: ${JSON.stringify(texts)}`);
    // 応答は5件すべて出ている（減らしてはいけないのは本文の側）
    assert.equal(texts.filter(t => /^応答/.test(t)).length, 5, JSON.stringify(texts));
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

test('種別ごとに件数を分けて数える（まとめて1つにしない）', () => {
    const c = collect();
    c.feed(skip('system', 'thinking_tokens'));
    c.feed(skip('system', 'thinking_tokens'));
    c.feed(skip('rate_limit_event'));
    c.feed(skip('rate_limit_event'));
    c.feed(skip('rate_limit_event'));
    c.flush();
    const texts = c.out.map(([, t]) => t);
    // 告知2行（種別ごと）+ 合計1行
    assert.equal(texts.length, 3, JSON.stringify(texts));
    const sum = texts[2];
    assert.match(sum, /thinking_tokens[^/]*×1/, `内訳が合わない: ${sum}`);
    assert.match(sum, /rate_limit_event[^/]*×2/, `内訳が合わない: ${sum}`);
});

/* ===== 送った行を「会話」として見せる（封筒を見せない） ===== */

test('🚨 chatInputText: stream-json の封筒から本文だけ取る', () => {
    const line = JSON.stringify({
        type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    assert.equal(chatInputText(line), 'hi');
});

test('chatInputText: 解釈できなければ null（呼び出し側が生のまま出す）', () => {
    assert.equal(chatInputText('ただの行'), null);
    assert.equal(chatInputText(JSON.stringify({ type: 'other' })), null);
    assert.equal(chatInputText(''), null);
    assert.equal(chatInputText(null), null);
    // content が配列でない形でも投げない
    assert.equal(chatInputText(JSON.stringify({ type: 'user', message: { content: 42 } })), null);
});

test('chatInputText: content が文字列の形も読む', () => {
    assert.equal(
        chatInputText(JSON.stringify({ type: 'user', message: { content: 'そのまま' } })),
        'そのまま');
});

/**
 * 🚨 **失敗の理由を捨てない（#69。10回目のレビュー / SERIOUS）。**
 *
 * 以前は `── ✖ エラー ──` の1行だけだったので、
 * 「Credit balance is too low」も `error_max_turns` も **同じ表示**になり、
 * 次に何をすればよいか判断できなかった。しかも `chatGlance` は
 * `interpreted: true` を返すので「解釈できない行」の印すら付かない。
 */
test('🚨 result: エラーの理由と subtype を出す', () => {
    const lines = chatRecordLines({
        type: 'result', is_error: true, subtype: 'error_during_execution',
        result: 'Credit balance is too low',
    });
    const text = lines.map(l => l.text).join('\n');
    assert.match(text, /error_during_execution/, `subtype が出ていない: ${text}`);
    assert.match(text, /Credit balance is too low/, `理由が出ていない: ${text}`);
});

test('🚨 result: 長い理由は切って、切ったことと全体の文字数を言う', () => {
    const long = 'x'.repeat(900);
    const lines = chatRecordLines({ type: 'result', is_error: true, result: long });
    const text = lines.map(l => l.text).join('\n');
    assert.ok(text.length < 500, `切っていない: ${text.length} 文字`);
    assert.match(text, /…/, `省略の印が無い: ${text.slice(0, 120)}`);
    assert.match(text, /900 文字/, `全体の文字数を言っていない: ${text.slice(-60)}`);
});

test('result: 成功は終端の1行のまま（本文は assistant 側で出ている）', () => {
    const lines = chatRecordLines({ type: 'result', is_error: false, subtype: 'success',
        result: '出来ました' });
    const text = lines.map(l => l.text).join('\n');
    assert.match(text, /応答おわり/);
    assert.equal(text.includes('出来ました'), false, `成功で本文を二重に出している: ${text}`);
});
