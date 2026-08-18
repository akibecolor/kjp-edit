// SPDX-License-Identifier: MIT
// node --test scripts/usage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarize, parseLines, PAGE_OPEN_SINCE } from './usage.mjs';

const TUNNEL = 'fractal2.tail73c198.ts.net';

test('日別に「開いた」と「実行」を数え、遠隔を区別する', () => {
    const s = summarize([
        { at: '2026-08-19T01:00:00Z', event: 'page-open', host: '127.0.0.1:7749', suppressed: 0 },
        { at: '2026-08-19T02:00:00Z', event: 'page-open', host: TUNNEL, suppressed: 0 },
        { at: '2026-08-19T03:00:00Z', event: 'start', host: TUNNEL },
        { at: '2026-08-19T03:01:00Z', event: 'start', host: '127.0.0.1:7749' },
        { at: '2026-08-19T03:02:00Z', event: 'input', host: TUNNEL },
        { at: '2026-08-20T01:00:00Z', event: 'page-open', host: TUNNEL, suppressed: 0 },
    ]);
    assert.deepEqual(s.days.map(d => d.date), ['2026-08-19', '2026-08-20']);
    const d0 = s.days[0];
    assert.equal(d0.opens, 2);
    // 🔒 遠隔（Host が tailnet 名）が実際の利用に近い指標。ループバックには検査が混ざる
    assert.equal(d0.opensRemote, 1, 'ループバックを遠隔として数えている');
    assert.equal(d0.execs, 2);
    assert.equal(d0.execsRemote, 1);
    assert.equal(d0.inputs, 1);
    assert.equal(s.totals.opensRemote, 2);
});

test('🚨 絞られた回数も「開いた」に数える（過少に見せない）', () => {
    // サーバは同じ出所を 60 秒に1回に絞り、絞った件数を次の記録に載せる。
    // ここで足さないと**実際に開いた回数より少なく**出る。
    const s = summarize([
        { at: `${PAGE_OPEN_SINCE}T01:00:00Z`, event: 'page-open', host: TUNNEL, suppressed: 0 },
        { at: `${PAGE_OPEN_SINCE}T02:00:00Z`, event: 'page-open', host: TUNNEL, suppressed: 4 },
    ]);
    assert.equal(s.days[0].opens, 6, '絞られた分を落としている（1 + 1+4 = 6）');
    assert.equal(s.days[0].opensRemote, 6);
    assert.equal(s.days[0].opensSuppressed, 4);
});

test('🚨 記録を足す前の日を「開かなかった」と数えない', () => {
    // ⚠️ ここが本題。`page-open` を足す前の日は**記録が無い**だけで、
    //    「開かなかった」ではない。0 と "-" を混同すると自分に嘘をつく。
    const s = summarize([
        { at: '2026-08-06T01:00:00Z', event: 'start', host: TUNNEL },
        { at: `${PAGE_OPEN_SINCE}T01:00:00Z`, event: 'page-open', host: TUNNEL, suppressed: 0 },
    ]);
    assert.equal(s.totals.days, 2);
    assert.equal(s.totals.daysWithOpenData, 1,
        '「開いた」を測れる日数を数えていない（測れない期間を 0 と読むことになる）');
});

test('🚨 知らない種別を黙って捨てない', () => {
    const s = summarize([
        { at: '2026-08-19T01:00:00Z', event: 'brand-new-event' },
        { at: '2026-08-19T01:00:00Z', event: 'exit' },   // 数えないが既知
    ]);
    assert.deepEqual(s.unknownEvents, ['brand-new-event'],
        '種別が増えたのに数えていない状態を黙って作っている');
    assert.equal(s.days[0].execs, 0);
});

test('壊れた行を数える（読めた行だけで結論を出さない）', () => {
    const { entries, broken } = parseLines(
        '{"at":"2026-08-19T01:00:00Z","event":"page-open"}\nこれは JSON ではない\n\n');
    assert.equal(entries.length, 1);
    assert.equal(broken, 1, '壊れた行を黙って無視している');
});

test('壊れた入力で投げない', () => {
    assert.deepEqual(summarize(undefined).days, []);
    assert.deepEqual(summarize([{ event: 'page-open' }]).days, [], 'at が無い行で落ちる');
    assert.equal(parseLines(undefined).entries.length, 0);
});
