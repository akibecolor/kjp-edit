// SPDX-License-Identifier: MIT
// node --test v0/ndjson.test.mjs
//
// ブラウザ側のストリーム処理の回帰テスト。
// この2つの罠は「たまに文字化けする」形でしか出ないので、
// 意図的に最悪の位置で chunk を割って固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNdjson } from './ndjson.mjs';

/** 与えたバイト列をそのまま chunk 単位で流す ReadableStream */
function streamOf(chunks) {
    return new ReadableStream({
        start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
        },
    });
}

const enc = new TextEncoder();

async function collect(chunks) {
    const out = [];
    for await (const ev of parseNdjson(streamOf(chunks))) out.push(ev);
    return out;
}

test('普通に1行ずつ来る場合', async () => {
    const events = await collect([
        enc.encode('{"t":"out","d":"a"}\n'),
        enc.encode('{"t":"exit","code":0}\n'),
    ]);
    assert.deepEqual(events, [{ t: 'out', d: 'a' }, { t: 'exit', code: 0 }]);
});

// 罠1: JSON の行が chunk 境界で割れる
test('regression: JSON の行が chunk 境界で割れても復元する', async () => {
    const whole = '{"t":"out","d":"hello world"}\n{"t":"exit","code":0}\n';
    const bytes = enc.encode(whole);
    // 1バイトずつ流す（最悪ケース）
    const chunks = [...bytes].map(b => new Uint8Array([b]));
    const events = await collect(chunks);
    assert.deepEqual(events, [{ t: 'out', d: 'hello world' }, { t: 'exit', code: 0 }]);
});

// 罠2: マルチバイト文字が chunk 境界で割れる
test('regression: 3バイト文字が chunk 境界で割れても壊れない', async () => {
    const text = 'あいうえお漢字テスト';
    const whole = `${JSON.stringify({ t: 'out', d: text })}\n`;
    const bytes = enc.encode(whole);
    // 3バイト文字の途中で必ず割れるように、あらゆる位置で2分割して試す
    for (let cut = 1; cut < bytes.length; cut++) {
        const events = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
        assert.deepEqual(events, [{ t: 'out', d: text }],
            `cut=${cut} で壊れた`);
        assert.ok(!JSON.stringify(events).includes('�'),
            `cut=${cut} で置換文字が入った`);
    }
});

test('regression: 1バイトずつでも日本語が壊れない', async () => {
    const text = '日本語フォルダ/テスト ファイル.txt';
    const bytes = enc.encode(`${JSON.stringify({ t: 'out', d: text })}\n`);
    const events = await collect([...bytes].map(b => new Uint8Array([b])));
    assert.deepEqual(events, [{ t: 'out', d: text }]);
});

test('最後の行に改行が無くても取り出す', async () => {
    const events = await collect([enc.encode('{"t":"exit","code":1}')]);
    assert.deepEqual(events, [{ t: 'exit', code: 1 }]);
});

test('壊れた行は黙って捨てず __parseError で返す', async () => {
    const events = await collect([
        enc.encode('{"t":"out","d":"ok"}\nこれはJSONではない\n{"t":"exit","code":0}\n'),
    ]);
    assert.equal(events.length, 3);
    assert.equal(events[1].__parseError, 'これはJSONではない');
    // 壊れた行の後も処理が続くこと（1行の破損で残りを失わない）
    assert.deepEqual(events[2], { t: 'exit', code: 0 });
});

// 🚨 `null` 行を素通しすると呼び出し側の `ev.__parseError` が TypeError になり、
//    ストリームの読み取りが中断されて**サーバ側の子プロセスが取り残される**
//    （レビューで実証）。オブジェクト以外は解析失敗として扱う。
test('regression: オブジェクト以外の行を素通しさせない', async () => {
    const events = await collect([
        enc.encode('null\n123\n"str"\ntrue\n[1,2]\n{"t":"exit","code":0}\n'),
    ]);
    assert.equal(events.length, 6);
    for (let i = 0; i < 5; i++) {
        assert.ok(typeof events[i] === 'object' && events[i] !== null,
            `${i} 番目が非オブジェクト: ${JSON.stringify(events[i])}`);
        assert.ok('__parseError' in events[i],
            `${i} 番目が解析失敗として扱われていない: ${JSON.stringify(events[i])}`);
    }
    assert.deepEqual(events[5], { t: 'exit', code: 0 });
});

test('regression: 改行の来ない巨大な1行を切り詰める', async () => {
    // 1.5MB の1行（改行なし）
    const huge = 'x'.repeat(1_500_000);
    const events = await collect([enc.encode(huge)]);
    assert.ok(events.length >= 1);
    assert.ok(events[0].__parseError, '解析失敗として返っていない');
    assert.ok(events[0].__parseError.length < 1000,
        `切り詰められていない: ${events[0].__parseError.length} 文字`);
});

// 🚨 break したときに接続を閉じないと、サーバは切断を検知せず子プロセスが残る。
test('regression: break したらストリームを cancel する', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(enc.encode('{"t":"out","d":"a"}\n'));
            c.enqueue(enc.encode('{"t":"out","d":"b"}\n'));
        },
        cancel() { cancelled = true; },
    });
    for await (const ev of parseNdjson(stream)) {
        void ev;
        break;                     // 1件で抜ける
    }
    assert.equal(cancelled, true, 'cancel が呼ばれていない（接続が開いたまま）');
});

test('空行は無視する', async () => {
    const events = await collect([enc.encode('\n\n{"t":"exit","code":0}\n\n')]);
    assert.deepEqual(events, [{ t: 'exit', code: 0 }]);
});

test('大量の行を取りこぼさない', async () => {
    const n = 2000;
    let whole = '';
    for (let i = 0; i < n; i++) whole += `${JSON.stringify({ t: 'out', d: `行${i}` })}\n`;
    const bytes = enc.encode(whole);
    // 中途半端なサイズで刻む（行境界と一致しない）
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 997) chunks.push(bytes.slice(i, i + 997));
    const events = await collect(chunks);
    assert.equal(events.length, n);
    assert.equal(events[0].d, '行0');
    assert.equal(events.at(-1).d, `行${n - 1}`);
    assert.equal(events.filter(e => e.__parseError).length, 0, '解析できない行がある');
});
