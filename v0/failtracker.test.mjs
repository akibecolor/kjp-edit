// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFailTracker, makeInflightGate, makeGoodSet, failDelay, secretHash } from './failtracker.mjs';

/** 時間と監査を注入して決定的に測る（タイマーを待たない） */
function harness(opts = {}) {
    let t = 1_000_000;
    const audited = [];
    const slept = [];
    const tracker = makeFailTracker({
        audit: async rec => { audited.push(rec); },
        event: 'x-failed', summaryEvent: 'x-failed-summary',
        now: () => t,
        sleep: async ms => { slept.push(ms); },
        ...opts,
    });
    return { tracker, audited, slept, advance: ms => { t += ms; }, at: () => t };
}

test('failDelay: 3回までは遅らせず、そこから指数で最大 2 秒', () => {
    assert.equal(failDelay(1), 0);
    assert.equal(failDelay(3), 0);
    // 実測した曲線（3回まで 0 → 100, 200, 400, 800, 1600 → 2000 で頭打ち）。
    // ⚠️ **期待値を手で置く前に実際の値を出す。** ここで 50 と書いて落とした
    //    （`2 ** (count - 3) * 50` は count=4 で **100**。CLAUDE.md の
    //     「テストが誤っている可能性を先に潰す」= このリポジトリで3件目）。
    assert.equal(failDelay(4), 100);
    assert.equal(failDelay(5), 200);
    assert.equal(failDelay(8), 1600);
    assert.equal(failDelay(9), 2000, '上限を超えている（タイマーが溜まる）');
    assert.equal(failDelay(1e6), 2000);
    // ⚠️ 数でない値で NaN の遅延を作らない（setTimeout(NaN) は即時になる）
    assert.equal(failDelay(undefined), 0);
    assert.equal(failDelay(NaN), 0);
});

// 🚨 **期待値を先に言語化する。** 20 本外したときに何が起きるのが正しいか:
//    個別行は先頭3本だけ。4本目で「まとめ始めた」と分かる集約行が1本出る
//    （= すぐ気付ける）。それ以降は 10 秒に1回だけで、**累計はその刻みで告げる**。
//    「最後の集約行が最終状態を映す」ではない（時間で刻むのだから当然そうなる）。
test('note: 個別行は先頭3本だけ。残りは集約行になる（外からログを伸ばせない）', async () => {
    const h = harness({ summaryMs: 10_000 });
    for (let i = 0; i < 20; i++) await h.tracker.note('peer-a', { path: '/x' });
    const individual = h.audited.filter(r => r.event === 'x-failed');
    let summary = h.audited.filter(r => r.event === 'x-failed-summary');
    assert.equal(individual.length, 3, `個別行が3本でない: ${individual.length}`);
    assert.equal(summary.length, 1, `集約行が1本でない: ${summary.length}`);
    assert.equal(summary[0].logged, 3);
    assert.ok(summary[0].suppressed >= 1, '捨てた本数を告げていない');
    // 累計は次の刻みで出る（20 本を黙って捨てない）
    h.advance(10_500);
    await h.tracker.note('peer-a', { path: '/x' });
    summary = h.audited.filter(r => r.event === 'x-failed-summary');
    assert.equal(summary.length, 2);
    assert.equal(summary[1].attempts, 21, `累計が合わない: ${summary[1].attempts}`);
    assert.equal(summary[1].suppressed, 18, `まとめた本数が合わない: ${summary[1].suppressed}`);
    assert.equal(h.audited.filter(r => r.event === 'x-failed').length, 3,
        '個別行が増えている（外からログを伸ばせる）');
});

test('note: 集約行は件数ではなく時間で刻む（毎秒1万本撃たれても伸びない）', async () => {
    const h = harness({ summaryMs: 10_000 });
    for (let i = 0; i < 500; i++) await h.tracker.note('peer-a');
    assert.equal(h.audited.filter(r => r.event === 'x-failed-summary').length, 1);
    h.advance(9_000);
    for (let i = 0; i < 500; i++) await h.tracker.note('peer-a');
    assert.equal(h.audited.filter(r => r.event === 'x-failed-summary').length, 1,
        '10 秒経っていないのに集約行が増えた');
    h.advance(1_500);
    await h.tracker.note('peer-a');
    assert.equal(h.audited.filter(r => r.event === 'x-failed-summary').length, 2,
        '時間が経っても集約行が出ない（何本外されたか分からなくなる）');
});

test('note: 遅延が実際に掛かる（回数に応じて伸びる）', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) await h.tracker.note('peer-a');
    assert.deepEqual(h.slept, [100, 200, 400], `遅延が掛かっていない: ${JSON.stringify(h.slept)}`);
});

test('note: 記録に本文を混ぜない（候補の値を残さない）', async () => {
    const h = harness();
    await h.tracker.note('peer-a', { path: '/api/v0/exec' });
    const line = JSON.stringify(h.audited[0]);
    assert.match(line, /\/api\/v0\/exec/);
    assert.equal(line.includes('token'), false, `記録に token 由来の欄がある: ${line}`);
});

test('窓が変わったら前の窓を締めてから作り直す（数え直しが 0 に戻る）', async () => {
    const h = harness({ windowMs: 60_000 });
    for (let i = 0; i < 10; i++) await h.tracker.note('peer-a');
    assert.equal(h.tracker.peek('peer-a').count, 10);
    h.advance(61_000);
    await h.tracker.note('peer-a');
    assert.equal(h.tracker.peek('peer-a').count, 1, '窓が変わっても数が続いている');
    const rolled = h.audited.filter(r => r.why === 'window-rolled');
    assert.equal(rolled.length, 1, '前の窓を締めずに捨てた（何本外されたかが消える）');
});

test('peer の台帳に上限がある（外から無制限に増やせない）', async () => {
    const h = harness({ maxPeers: 8, windowMs: 1000 });
    for (let i = 0; i < 20; i++) await h.tracker.note(`peer-${i}`);
    // 窓が生きている間は落とせないので、時間を進めてから新しい peer を入れる
    h.advance(2000);
    await h.tracker.note('peer-new');
    assert.ok(h.tracker.size <= 9, `台帳が上限を超えて増えている: ${h.tracker.size}`);
});

// 🚨 期待値を先に言語化する（実装に合わせて後から決めない）:
//    最初の1本で**すぐ**集約行が出る（切り始めたことが即座に分かる）。
//    そこから 10 秒はまとめられ、**次の刻みで累計が出る**（捨てた分は必ず後で告げる）。
test('shed: 比較せず切った本数も集約に残る（黙って捨てない）', async () => {
    const h = harness({ summaryMs: 10_000 });
    for (let i = 0; i < 100; i++) h.tracker.shed('peer-a');
    let summary = h.audited.filter(r => r.event === 'x-failed-summary');
    assert.equal(summary.length, 1, '切り始めたことが即座に出ていない');
    assert.equal(summary[0].shed, 1, '1本目の集約行の時点の件数が合わない');
    assert.equal(summary[0].attempts, 0, '比較していないのに attempts に数えている');
    // 累計は次の刻みで必ず出る（100 本を黙って捨てない）
    h.advance(10_500);
    h.tracker.shed('peer-a');
    summary = h.audited.filter(r => r.event === 'x-failed-summary');
    assert.equal(summary.length, 2, '時間が経っても累計が出ない');
    assert.equal(summary[1].shed, 101, `累計が合わない: ${summary[1].shed}`);
    // ⚠️ shed は1本1行を書かない（429 は毎秒1万本以上撃てる）
    assert.equal(h.audited.filter(r => r.event === 'x-failed').length, 0,
        'shed で個別行を書いている（外からログを伸ばせる）');
});

test('flushAll: 終了時に集約待ちを落とさない', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.tracker.shed('peer-a');
    h.audited.length = 0;
    h.advance(1);
    await h.tracker.flushAll('shutdown');
    // 既に1本出ているので、増分が無ければ出ない。増分を作ってから測る
    for (let i = 0; i < 5; i++) h.tracker.shed('peer-b');
    h.audited.length = 0;
    await h.tracker.flushAll('shutdown');
    assert.ok(h.audited.some(r => r.why === 'shutdown'),
        '終了時の集約行が出ていない（何本外されたかが消える）');
});

test('makeInflightGate: 上限まで取れて、返すと空く', () => {
    const g = makeInflightGate(2);
    assert.equal(g.acquire('a'), true);
    assert.equal(g.acquire('a'), true);
    assert.equal(g.acquire('a'), false, '上限を超えて取れている（並列で縛れない）');
    // peer ごとに独立（別の相手を巻き込まない）
    assert.equal(g.acquire('b'), true);
    g.release('a');
    assert.equal(g.acquire('a'), true, '返しても空かない（正規の利用者を締め出す）');
    g.release('a'); g.release('a'); g.release('b');
    assert.equal(g.count('a'), 0);
    assert.equal(g.count('b'), 0);
});

test('makeGoodSet: 覚えた値は素通り。TTL を過ぎたら覚えていない', () => {
    let t = 0;
    const s = makeGoodSet({ ttlMs: 1000, max: 4, now: () => t });
    assert.equal(s.has(['v1']), false);
    s.remember(['v1']);
    assert.equal(s.has(['v1']), true);
    assert.equal(s.has(['other']), false, '覚えていない値が素通りしている');
    t = 1500;
    assert.equal(s.has(['v1']), false, 'TTL を過ぎても素通りしている');
});

test('makeGoodSet: 件数の上限がある（覚えるだけでメモリを埋められない）', () => {
    let t = 0;
    const s = makeGoodSet({ ttlMs: 10, max: 4, now: () => t });
    for (let i = 0; i < 50; i++) { s.remember([`v${i}`]); t += 1; }
    assert.ok(s.size <= 4, `上限を超えて覚えている: ${s.size}`);
});

test('secretHash: 値そのものを持たない（同じ値は同じハッシュ）', () => {
    assert.equal(secretHash('abc'), secretHash('abc'));
    assert.notEqual(secretHash('abc'), secretHash('abd'));
    assert.match(secretHash('abc'), /^[0-9a-f]{64}$/);
    assert.equal(secretHash('abc').includes('abc'), false);
});
