// SPDX-License-Identifier: MIT
// node --test v0/execsession.test.mjs
//
// 切断で殺さない代わりに置いた制約を固定する（#17）。
// ⚠️ 時間を実際に待たない。`now` を注入し、掃除の判断は純関数 sweep(now) で見る。
//    タイマーを待つテストは遅いだけでなく、**落ちたときに原因が分からない**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecRegistry, RingLog, isSessionId, DEFAULTS } from './execsession.mjs';

const MIN = 60 * 1000;

function reg(over = {}) {
    let t = 1_000_000;
    const r = new ExecRegistry({
        execTimeoutMs: 10 * MIN,
        limits: { detachedGraceMs: 5 * MIN, retainMs: 10 * MIN, ...over },
        now: () => t,
    });
    r.advance = ms => { t += ms; };
    r.at = () => t;
    return r;
}
const mk = (r, over = {}) => r.create({ worktree: '/wt/a', argv: ['npm', 'test'], ...over });

// ---------------------------------------------------------------------------
// リングバッファ
// ---------------------------------------------------------------------------

test('RingLog: 通番が単調に増え、since で続きだけ取れる', () => {
    const log = new RingLog();
    log.push('out', 'a');
    log.push('out', 'b');
    log.push('out', 'c');
    assert.deepEqual(log.since(0).records.map(r => r.d), ['a', 'b', 'c']);
    assert.deepEqual(log.since(2).records.map(r => r.d), ['c']);
    assert.deepEqual(log.since(3).records, []);
    assert.equal(log.since(0).missing, 0);
});

// 🚨 省略したことを告知できないと、利用者は出力が完全だと誤解する
test('🚨 RingLog: 上限で捨てたら missing で告知できる', () => {
    const log = new RingLog({ maxBytes: 10 });
    for (const d of ['aaaa', 'bbbb', 'cccc', 'dddd']) log.push('out', d);
    assert.ok(log.dropped > 0, '上限を超えても捨てていない');
    const r = log.since(0);
    assert.ok(r.missing > 0, `捨てたのに missing が 0（${JSON.stringify(r)}）`);
    assert.equal(r.missing, log.dropped, '取りこぼし件数が合わない');
    // 直近は必ず残っている（購読者に流す対象なので）
    assert.equal(r.records[r.records.length - 1].d, 'dddd');
});

test('RingLog: 件数の上限も効く', () => {
    const log = new RingLog({ maxRecords: 3, maxBytes: 1 << 20 });
    for (let i = 0; i < 10; i++) log.push('out', String(i));
    assert.equal(log.records.length, 3);
    assert.equal(log.dropped, 7);
});

// ⚠️ 内部用のフィールドを持たせると、そのまま JSON にして送ったときに漏れる
test('RingLog: レコードに内部用フィールドを混ぜない（電文の形のまま）', () => {
    const log = new RingLog();
    log.push('out', 'x');
    assert.deepEqual(Object.keys(log.records[0]).sort(), ['d', 'n', 't']);
});

test('RingLog: マルチバイトをバイト数で数える（文字数で数えない）', () => {
    const log = new RingLog({ maxBytes: 1 << 20 });
    log.push('out', 'あ');            // UTF-8 で3バイト
    assert.equal(log.bytes, 3);
});

// ---------------------------------------------------------------------------
// 台帳と上限
// ---------------------------------------------------------------------------

test('isSessionId: 形の違うものを弾く', () => {
    assert.ok(isSessionId('0123456789abcdef'));
    for (const bad of ['', 'xyz', '0123456789ABCDEF', '0123456789abcde',
        '0123456789abcdef0', '../../etc', null, 42]) {
        assert.equal(isSessionId(bad), false, `通してはいけない: ${String(bad)}`);
    }
});

test('セッション id は序数ではなく衝突しない', () => {
    const r = reg();
    const ids = new Set();
    for (let i = 0; i < 8; i++) ids.add(mk(r).id);
    assert.equal(ids.size, 8);
    for (const id of ids) assert.ok(isSessionId(id), `形が違う: ${id}`);
    assert.ok(![...ids].some(id => /^0+[0-7]$/.test(id)), '序数になっている');
});

// 🚨 検査と予約が別の同期ブロックだと上限が効かない（8に対して24本走った実測がある）
test('🚨 同時セッションの上限が効き、終了すると枠が戻る', () => {
    const r = reg();
    const made = [];
    for (let i = 0; i < DEFAULTS.maxConcurrent; i++) {
        const s = mk(r);
        assert.ok(s, `${i} 本目で作れなかった`);
        made.push(s);
    }
    assert.equal(mk(r), null, '上限を超えて作れてしまった');
    r.finish(made[0], { code: 0 });
    assert.ok(mk(r), '終了しても枠が戻らない');
});

test('finish は二重に呼ばれても1回しか効かない（枠を二重に返さない）', () => {
    const r = reg();
    const s = mk(r);
    assert.equal(r.finish(s, { code: 0 }), true);
    assert.equal(r.finish(s, { code: 1 }), false, '2回目が効いている');
    assert.equal(r.reserved, 0);
    assert.equal(s.exit.code, 0, '2回目の値で上書きされている');
});

test('finish: 理由（note）は exit より前に流れる', () => {
    const r = reg();
    const s = mk(r);
    const got = [];
    r.subscribe(s, 0, rec => got.push(rec));
    r.finish(s, { code: null, signal: 'SIGKILL', note: '⚠ 上限時間' });
    assert.deepEqual(got.map(x => x.t), ['err', 'exit']);
    assert.equal(got[1].signal, 'SIGKILL');
});

// ---------------------------------------------------------------------------
// 購読と再接続（ここが #17 の本体）
// ---------------------------------------------------------------------------

test('🚨 切断しても running のまま。再購読で切断中の出力が再生される', () => {
    const r = reg();
    const s = mk(r);
    r.attachChild(s, { pid: 1 });

    const first = [];
    const sub = r.subscribe(s, 0, rec => first.push(rec));
    r.emit(s, 'out', 'before');
    assert.deepEqual(first.map(x => x.d), ['before']);

    // 切断（スマホがタブを止めた）
    sub.unsubscribe();
    assert.equal(s.state, 'running', '切断で状態が変わっている');
    assert.equal(s.subscribers.size, 0);

    // 切断中も出力は溜まる
    r.emit(s, 'out', 'while-away-1');
    r.emit(s, 'out', 'while-away-2');

    // 再購読。最後に見た通番の続きから貰う
    const lastSeen = first[first.length - 1].n;
    const again = r.subscribe(s, lastSeen, () => {});
    assert.deepEqual(again.replay.records.map(x => x.d), ['while-away-1', 'while-away-2'],
        '切断中の出力が再生されない');
    assert.equal(again.replay.missing, 0);
    assert.equal(s.lastDetachedAt, null, '再購読で切断時刻が消えていない');
});

test('再購読は取りこぼしがあれば missing で告知する', () => {
    const r = reg({ });
    const s = mk(r);
    s.log.maxBytes = 8;   // すぐ捨てる
    r.attachChild(s, { pid: 1 });
    for (const d of ['1111', '2222', '3333', '4444']) r.emit(s, 'out', d);
    const { replay } = r.subscribe(s, 0, () => {});
    assert.ok(replay.missing > 0, '捨てたのに告知されない');
});

// ---------------------------------------------------------------------------
// 掃除の方針（守りを緩めた代わりの制約）
// ---------------------------------------------------------------------------

test('走っているセッションは、購読者がいる限り掃除されない', () => {
    const r = reg();
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {});
    r.advance(9 * MIN);
    assert.deepEqual(r.sweep().kill, [], '購読中なのに殺されようとしている');
});

test('🚨 切断後は猶予が過ぎたら殺す（取り残しの経路を作らない）', () => {
    const r = reg({ detachedGraceMs: 5 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    const sub = r.subscribe(s, 0, () => {});
    sub.unsubscribe();

    r.advance(5 * MIN - 1);
    assert.deepEqual(r.sweep().kill, [], '猶予の中で殺している');
    r.advance(1);
    const { kill } = r.sweep();
    assert.equal(kill.length, 1, '猶予を過ぎても殺していない = 取り残しが戻っている');
    assert.equal(kill[0].reason, 'detached');
    assert.equal(kill[0].session.id, s.id);
});

test('再購読すると猶予はやり直しになる', () => {
    const r = reg({ detachedGraceMs: 5 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {}).unsubscribe();
    r.advance(4 * MIN);
    r.subscribe(s, 0, () => {}).unsubscribe();   // 戻ってきて、また離れた
    r.advance(4 * MIN);
    assert.deepEqual(r.sweep().kill, [], '再購読で猶予がやり直しになっていない');
    r.advance(1 * MIN);
    assert.equal(r.sweep().kill.length, 1);
});

/**
 * 🚨 **#49: 入力している最中のセッションを猶予で殺してはいけない。**
 *
 * 監視盤は**購読せずに**入力できる（`/api/v0/exec/list` + `/input`）。
 * 猶予が購読/解除の時刻でしか進まないと、スマホから返事を書いている最中に
 * 「切断されたまま N 秒経った」で SIGKILL される。並列でエージェントを
 * 回すという**本来の使い方でだけ**起きる壊れ方。
 */
test('🚨 入力が通ったら切断後の猶予はやり直しになる（#49）', () => {
    const r = reg({ detachedGraceMs: 5 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {}).unsubscribe();

    r.advance(4 * MIN);
    assert.equal(r.noteInput(s), true, '猶予を延ばせていない');
    r.advance(4 * MIN);
    assert.deepEqual(r.sweep().kill, [],
        '入力したのに猶予が延びていない（返事を書いている最中に殺される）');
    r.advance(1 * MIN + 1);
    assert.equal(r.sweep().kill.length, 1, '入力が止まっても猶予が効かなくなっている');
});

test('購読中の入力は猶予に触らない（購読中は既に猶予の外）', () => {
    const r = reg({ detachedGraceMs: 5 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {});
    assert.equal(r.noteInput(s), false, '購読中に猶予の起点を作っている');
    assert.equal(s.lastDetachedAt, null, '購読中なのに切断時刻が入っている');
});

test('終わったセッションへの入力では猶予を延ばさない（死体を延命しない）', () => {
    const r = reg({ detachedGraceMs: 5 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.finish(s, { code: 0 });
    assert.equal(r.noteInput(s), false, '終了済みのセッションで猶予を延ばした');
});

test('keepAlive なら切断しても猶予では殺さない（絶対上限だけで縛る）', () => {
    const r = reg({ detachedGraceMs: 1 * MIN });
    const s = mk(r, { keepAlive: true });
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {}).unsubscribe();
    r.advance(9 * MIN);
    assert.deepEqual(r.sweep().kill, [], 'keepAlive なのに猶予で殺している');
});

// 🚨 絶対上限は緩めない。ここが効かないと keepAlive が無限に走る
test('🚨 絶対上限（--exec-timeout）は keepAlive でも効く', () => {
    const r = reg({ detachedGraceMs: 1 * MIN });
    const s = mk(r, { keepAlive: true });
    r.attachChild(s, { pid: 1 });
    r.subscribe(s, 0, () => {});          // 購読し続けている
    r.advance(10 * MIN);
    const { kill } = r.sweep();
    assert.equal(kill.length, 1, '絶対上限が効いていない');
    assert.equal(kill[0].reason, 'timeout');
});

test('終了したセッションは保持期間のあいだ残り、過ぎたら台帳から消える', () => {
    const r = reg({ retainMs: 10 * MIN });
    const s = mk(r);
    r.attachChild(s, { pid: 1 });
    r.finish(s, { code: 0 });

    r.advance(9 * MIN);
    assert.deepEqual(r.sweep().evict, [], '出力を読みに戻れる前に消している');
    assert.ok(r.get(s.id), '台帳から消えている');

    r.advance(2 * MIN);
    const { evict } = r.sweep();
    assert.equal(evict.length, 1, '保持期間を過ぎても消えない = 溜まり続ける');
    r.remove(evict[0]);
    assert.equal(r.get(s.id), null);
});

// 🚨 以前は「購読者がいる間は消さない」にしていたが、**切断を検知できない
//    購読者（詰まったソケット等）が1つ残るだけで永久に消えなくなった**
//    （レビューで実測: RSS が伸び続ける）。終了済みなら新しい出力は来ないので、
//    保持期間を過ぎたら購読者がいても消す。
test('🚨 終了後は保持期間を過ぎたら購読者がいても消す（詰まった購読者で永久に残さない）', () => {
    const r = reg({ retainMs: 1 * MIN });
    const s = mk(r);
    r.finish(s, { code: 0 });
    r.subscribe(s, 0, () => {});   // 切断を検知できない購読者に相当

    r.advance(30 * 1000);
    assert.deepEqual(r.sweep().evict, [], '保持期間の中で消している（読みに戻れない）');

    r.advance(1 * MIN);
    const { evict } = r.sweep();
    assert.equal(evict.length, 1, '購読者がいると永久に残る（メモリが溜まり続ける）');
    r.remove(evict[0]);
    assert.equal(r.get(s.id), null);
    assert.equal(s.subscribers.size, 0, '購読者の参照が残っている（応答が回収されない）');
});

// 🚨 create() から spawn() までに await が入るので、その隙に sweep や /kill で
//    終わっていることがある。無条件に running へ戻すと「停止した」と告げた後に
//    走り続け、あとで exit したときに枠が二重に返る。
test('🚨 attachChild は終わったセッションを running に戻さない', () => {
    const r = reg();
    const s = mk(r);
    // 起動を待っている間に停止された
    assert.equal(r.finish(s, { code: null, signal: 'SIGKILL', note: '停止' }), true);
    assert.equal(r.reserved, 0, '枠が返っていない');

    assert.equal(r.attachChild(s, { pid: 1 }), false, '終わったセッションに子を付けた');
    assert.equal(s.state, 'done', 'running に戻っている（停止したのに動く）');
    assert.equal(s.child, null, '子が結び付けられている');

    // 二重に枠を返さない
    assert.equal(r.finish(s, { code: 0 }), false);
    assert.equal(r.reserved, 0, '枠が二重に返った（上限が緩む）');
});

test('attachChild は走っているセッションには付く（正常系を壊していない）', () => {
    const r = reg();
    const s = mk(r);
    assert.equal(r.attachChild(s, { pid: 42 }), true);
    assert.equal(s.state, 'running');
    assert.equal(s.child.pid, 42);
});

// ---------------------------------------------------------------------------
// 一覧（UI が「取り残し」を見つけるための唯一の窓）
// ---------------------------------------------------------------------------

test('list: 新しい順で、出力の中身は含まない', () => {
    const r = reg();
    const a = mk(r, { argv: ['npm', 'test'] });
    r.advance(1000);
    const b = mk(r, { argv: ['claude', '-p', 'ひみつの指示'] });
    r.attachChild(a, { pid: 1 });
    r.emit(a, 'out', 'SECRET-OUTPUT-9999');

    const list = r.list();
    assert.deepEqual(list.map(x => x.id), [b.id, a.id], '新しい順になっていない');
    const json = JSON.stringify(list);
    assert.ok(!json.includes('SECRET-OUTPUT-9999'), '一覧に出力の中身が入っている');
    // argv は出す（何が走っているか分からないと止める判断ができない）
    assert.ok(json.includes('npm'), 'argv が出ていない');
    // 切断中なら「あと何秒で止まるか」が分かる材料を出す
    assert.equal(typeof list.find(x => x.id === a.id).detachedMs, 'number');
});

test('describe: 切断していなければ detachedMs は null', () => {
    const r = reg();
    const s = mk(r);
    r.subscribe(s, 0, () => {});
    assert.equal(s.describe(r.at()).detachedMs, null);
});

// ---------------------------------------------------------------------------
// 監視盤に出す「最後の出力」
// ---------------------------------------------------------------------------

test('🚨 監視盤の最後の出力は行の構造を保つ（会話モードの JSON を壊さない）', () => {
    const r = reg();
    const s = mk(r);
    // ⚠️ `out` は行の途中で切れて届く。**連結してから**返す必要がある
    //    （1レコードだけ見ると壊れた JSON になり、監視盤が解釈できない）
    r.emit(s, 'out', '{"type":"assist');
    r.emit(s, 'out', 'ant","message":{"content":[{"type":"text","text":"あ  い"}]}}\n');
    // 🚨 **2レコード以上で測る。** 1行だけだと空白を潰しても JSON として通って
    //    しまい、**守りを外しても緑**になる（実際にこの変異が生き残った）。
    //    改行が消える = 2行が1行に繋がって JSON.parse が失敗する、が本当の症状。
    r.emit(s, 'out', '{"type":"result","is_error":false}\n');
    const got = s.lastOutput();
    const lines = got.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 2, `行に組み直せていない: ${JSON.stringify(got)}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.message.content[0].text, 'あ  い', '中身の空白まで潰している');
    assert.equal(JSON.parse(lines[1]).type, 'result');
});

test('監視盤の最後の出力は上限で切り詰め、切ったことを告げる', () => {
    const r = reg();
    const s = mk(r);
    r.emit(s, 'out', `${'x'.repeat(50)}TAIL`);
    const got = s.lastOutput(10);
    assert.match(got, /^…/, '切り詰めたのに告知していない');
    assert.match(got, /TAIL$/, '末尾（最新）ではなく先頭を返している');
    assert.equal(got.length, 11);
});

test('監視盤の最後の出力: 入力（in）は出力として返さない', () => {
    const r = reg();
    const s = mk(r);
    r.emit(s, 'out', 'これは出力\n');
    r.emit(s, 'in', 'これは入力\n');
    assert.match(s.lastOutput(), /これは出力/);
    assert.ok(!s.lastOutput().includes('これは入力'), '入力を出力として見せている');
});

/**
 * 🚨 **実機で踏んだ形の回帰テスト。**
 *
 * claude の `result` 行は**最終回答の本文を含むので 7813 文字**あった（実測）。
 * 上限 2000 文字で末尾を切ると、監視盤には
 * `…"cache_read_input_tokens":42857` のような断片が出て、
 * 「終わったのか / 何と言われたのか」が**まったく読めない**。
 * 最後の1行が JSON として解釈できる形で返ることを固定する。
 */
test('🚨 監視盤の最後の出力は、長い result 行でも解釈できる形で返る', () => {
    const r = reg();
    const s = mk(r);
    r.emit(s, 'out', `${JSON.stringify({
        type: 'assistant', message: { content: [{ type: 'text', text: '調べました' }] },
    })}\n`);
    // 実測に合わせた大きさ（本文 + usage/cost で 7000 文字超）
    const big = JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        result: 'あ'.repeat(1200), usage: { pad: 'x'.repeat(3000) },
    });
    assert.ok(big.length > 4000, `テストの前提が崩れている: ${big.length}`);
    r.emit(s, 'out', `${big}\n`);
    const got = s.lastOutput();
    const lines = got.replace(/^…/, '').split('\n').filter(l => l.trim());
    const last = lines[lines.length - 1];
    assert.doesNotThrow(() => JSON.parse(last),
        `最後の行が解釈できない（断片が返っている）: ${JSON.stringify(last.slice(0, 80))}`);
    assert.equal(JSON.parse(last).type, 'result');
});

// ⚠️ 「先頭を行の境界に揃える」テストは**置かない。**
//    解釈する側は後ろから走査するので観測可能な差が無く、変異が SURVIVED した
//    （守りごと削除した。測れない守りを残さない）。

/**
 * 🚨 **終了済みの「件数」にも上限を置く（#72。10回目のレビュー / SERIOUS）。**
 *
 * 冒頭が掲げる「守りを緩めた代わりの制約」は 同時数 / 絶対上限 / 猶予 /
 * 保持期間 / リングのバイト数の5つで、**件数だけが無かった**。
 * `sweep()` の evict は経過時間しか見ないので、既定10分に終わった実行が全部残り、
 * 監視盤は4秒ごとに全件（各 lastOutput 付き）を引く。
 * 短いコマンドを回すのは**本来の使い方**なので悪意なしに踏む。
 */
test('🚨 終了済みの件数が上限を超えたら古いものから捨てる', () => {
    const reg = new ExecRegistry({ execTimeoutMs: 600_000, limits: { maxRetained: 3, retainMs: 60_000 } });
    let clock = 1000;
    reg.now = () => clock;
    const made = [];
    for (let i = 0; i < 6; i++) {
        const s = reg.create({ worktree: '/w', argv: ['git', '--version'] });
        reg.finish(s, { code: 0 });
        made.push(s);
        clock += 1;
    }
    const { evict } = reg.sweep(clock);
    assert.equal(evict.length, 3, `件数の上限が効いていない: ${evict.length}`);
    // 落ちるのは**古い方**（新しいものほど読みに戻る）
    assert.deepEqual(evict.map(s => s.id), made.slice(0, 3).map(s => s.id));
});

test('🚨 監視盤に返す件数を切ったら、切った数を返す（黙って省略しない）', () => {
    const reg = new ExecRegistry({ execTimeoutMs: 600_000, limits: { maxRetained: 100, retainMs: 60_000 } });
    let clock = 1000;
    reg.now = () => clock;
    for (let i = 0; i < 10; i++) {
        const s = reg.create({ worktree: '/w', argv: ['git', '--version'] });
        reg.finish(s, { code: 0 });
        clock += 1;
    }
    const r = reg.sessionsForMonitor(clock, 4);
    assert.equal(r.sessions.length, 4);
    assert.equal(r.omitted, 6, `省略した件数を返していない: ${JSON.stringify(r.omitted)}`);
    // 上限に掛からないときは 0（「省略しました」と嘘を言わない）
    assert.equal(reg.sessionsForMonitor(clock, 50).omitted, 0);
});

/**
 * ⚠️ **上限ちょうどのときに「切った」告知が消える（MINOR。10回目のレビュー）。**
 *
 * `text.length > max` で判定していたので、`acc.length === max` で break した回は
 * 前のレコードを**捨てているのに** `…` が付かず、告知なしで古い出力が消えていた。
 */
test('🚨 lastOutput: 上限ちょうどで切ったときも「…」を付ける', () => {
    const reg = new ExecRegistry({ execTimeoutMs: 600_000 });
    const s = reg.create({ worktree: '/w', argv: ['x'] });
    reg.emit(s, 'out', 'AAA');   // これは押し出される
    reg.emit(s, 'out', 'BB');
    reg.emit(s, 'out', 'CC');
    // 上限 4 = 'BB' + 'CC' でちょうど。前に 'AAA' が残っているので切っている
    const out = s.lastOutput(4);
    assert.equal(out, '…BBCC', `切ったのに告知が無い: ${JSON.stringify(out)}`);
    // 全部入るときは付けない（嘘の省略を出さない）
    assert.equal(s.lastOutput(100), 'AAABBCC');
});

/**
 * ⚠️ **1件も捨てていないのに「N 件を省略しました」と言わない（MINOR）。**
 *
 * `since(-1)` のような負の通番で再購読すると `firstKept - n - 1` が正になり、
 * 嘘の告知が出ていた。
 */
test('🚨 since: 負の通番でも「省略しました」と嘘を言わない', () => {
    const log = new RingLog({ bytes: 1024, records: 100 });
    log.push({ t: 'out', d: 'a' });
    log.push({ t: 'out', d: 'b' });
    const r = log.since(-5);
    assert.equal(r.missing, 0, `捨てていないのに省略と言った: ${r.missing}`);
    assert.equal(r.records.length, 2);
    assert.equal(log.since(0).missing, 0);
});

/**
 * 🚨 **自分の入力で「最後の出力」を消さない（MINOR。10回目のレビュー）。**
 *
 * `in` は出力と同じリングに積まれるので、長文を貼るだけで子の出力が押し出され、
 * `lastOutput()` が null になって監視盤の行から出力表示ごと消えていた。
 * しかも押し出したのは利用者自身の入力なのに「出力 N 件省略」と言う。
 */
test('🚨 長い入力はリングに本文を残さない（live には流す）', () => {
    const reg = new ExecRegistry({ execTimeoutMs: 600_000 });
    const s = reg.create({ worktree: '/w', argv: ['x'] });
    const live = [];
    reg.subscribe(s, 0, r => live.push(r));
    reg.emit(s, 'out', '大事な出力');
    const big = 'あ'.repeat(50_000);
    reg.emit(s, 'in', big);
    // 🔒 リングには本文が残らない（出力が押し出されない）
    const stored = s.log.records.find(r => r.t === 'in');
    assert.ok(stored.d.length < 300, `入力の本文がリングに残っている: ${stored.d.length} 文字`);
    assert.match(stored.d, /送信 \d+ バイト/, `送った量を言っていない: ${stored.d}`);
    assert.equal(s.lastOutput(), '大事な出力', '自分の入力で出力が押し出されている');
    // ⚠️ 購読者（端末）には**打った本文**がそのまま届く
    const sent = live.find(r => r.t === 'in');
    assert.equal(sent.d, big, '端末に打った内容が届いていない');
});
