// SPDX-License-Identifier: MIT
// node --test v0/devices.test.mjs
//
// 端末の承認（`docs/device-approval.md`）。**「承認していないのに通る」形を固定する。**
//
// 🚨 承認の根拠は「母艦でしか読めない合言葉を読めたこと」。
//    ネットワークの性質（peer / Host）では母艦を判定できない（実測済み）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DeviceBook, safeLabel, PAIR_TTL_MS, LABEL_MAX, MAX_TRIES,
} from './devices.mjs';

/** 時刻を手で進められる台帳 */
function book(start = 1000) {
    let t = start;
    const b = new DeviceBook({ now: () => t });
    return { b, tick: ms => { t += ms; } };
}

test('🚨 要求しただけでは鍵も台帳も増えない', () => {
    const { b } = book();
    b.request('スマホ');
    assert.equal(b.match('でたらめ'), null);
    assert.equal(b.list().length, 0, '要求だけで台帳に載っている');
});

test('🔒 合言葉は要求した端末に渡らない（current に含めない）', () => {
    const { b } = book();
    const r = b.request('スマホ');
    const cur = b.current();
    assert.equal(JSON.stringify(cur).includes(r.code), false,
        '承認待ちの情報に合言葉が入っている（応答に流れる経路ができる）');
    // 母艦だけが読める経路（server は stdout とファイルにしか書かない）
    assert.equal(b.codeFor(r.id), r.code);
    assert.equal(b.codeFor('別の id'), null, '他の要求の合言葉が読める');
});

test('🚨 合言葉が合えば鍵を1回だけ渡す', () => {
    const { b } = book();
    const r = b.request('スマホ');
    const ok = b.claim(r.id, r.code);
    assert.equal(ok.state, 'approved');
    assert.ok(ok.secret && ok.secret.length > 20);
    assert.equal(ok.device.hash, undefined, '応答に hash が出ている');
    // 2回目は取れない（再送で漏れる面を作らない）
    assert.equal(b.claim(r.id, r.code).state, 'unknown', '2回目も鍵を返している');
});

test('🚨 合言葉を外したら数え、上限で要求そのものを無効にする（6桁を当てさせない）', () => {
    const { b } = book();
    const r = b.request('スマホ');
    for (let i = 1; i < MAX_TRIES; i++) {
        const bad = b.claim(r.id, '000000');
        assert.equal(bad.state, 'bad-code');
        assert.equal(bad.triesLeft, MAX_TRIES - i);
    }
    assert.equal(b.claim(r.id, '000000').state, 'too-many', '上限を超えても続けられる');
    // 無効になったので、正しい合言葉でも通らない（やり直しは母艦で読み直す）
    assert.equal(b.claim(r.id, r.code).state, 'unknown');
    assert.equal(b.list().length, 0);
});

test('🚨 他人の要求に相乗りできない（id も一致させる）', () => {
    const { b } = book();
    const r = b.request('スマホ');
    assert.equal(b.claim('別の id', r.code).state, 'unknown', 'id が違うのに通った');
    assert.equal(b.claim(r.id, r.code).state, 'approved');
});

test('🚨 承認待ちは1件だけ。上書きしたら「上書きした」と返す（黙って捨てない）', () => {
    const { b } = book();
    const first = b.request('古い端末');
    const second = b.request('新しい端末');
    assert.ok(second.replaced, '上書きを告げていない');
    assert.equal(second.replaced.label, '古い端末');
    assert.equal(b.current().label, '新しい端末');
    // 古い要求の合言葉はもう使えない
    assert.equal(b.claim(first.id, first.code).state, 'unknown');
});

test('🚨 承認待ちは期限で切れる（合言葉を当てる時間を与えない）', () => {
    const { b, tick } = book();
    const r = b.request('スマホ');
    tick(PAIR_TTL_MS);
    assert.equal(b.current(), null, '期限切れが残っている');
    assert.equal(b.claim(r.id, r.code).state, 'unknown', '期限切れで通った');
});

test('承認した鍵は通り、初回だけ firstUse が立つ', () => {
    const { b } = book();
    const r = b.request('スマホ');
    const ok = b.claim(r.id, r.code);
    const m1 = b.match(ok.secret);
    assert.equal(m1.label, 'スマホ');
    assert.equal(m1.firstUse, true, '初回を告げていない');
    assert.equal(b.match(ok.secret).firstUse, false, '2回目も初回と言っている');
});

test('🚨 失効したらその端末だけ通らない（他は生きる）', () => {
    const { b } = book();
    const r1 = b.request('A');
    const a = b.claim(r1.id, r1.code);
    const r2 = b.request('B');
    const c = b.claim(r2.id, r2.code);
    assert.equal(b.revoke(a.device.id).ok, true);
    assert.equal(b.match(a.secret), null, '失効した鍵が通る');
    assert.ok(b.match(c.secret), '関係ない端末まで止まっている');
    // 2回目の失効は「すでに失効」と言う（黙って成功と言わない）
    const again = b.revoke(a.device.id);
    assert.equal(again.ok, false);
    assert.match(again.why, /すでに/);
    assert.equal(b.revoke('いない').ok, false);
});

test('🔒 一覧と保存に平文の鍵が出ない（hash だけ）', () => {
    const { b } = book();
    const r = b.request('スマホ');
    const a = b.claim(r.id, r.code);
    const listed = JSON.stringify(b.list());
    assert.equal(listed.includes(a.secret), false, '一覧に平文の鍵が出ている');
    assert.equal(listed.includes('hash'), false, '一覧に hash が出ている');
    const saved = JSON.stringify(b.toJSON());
    assert.equal(saved.includes(a.secret), false, '保存に平文の鍵が出ている');
    assert.ok(saved.includes('hash'), '照合に必要な hash が保存されていない');
});

test('safeLabel: 制御文字と改行を落とし、長すぎたら切って告げる', () => {
    assert.equal(safeLabel('  スマホ\n(Pixel)  '), 'スマホ (Pixel)');
    assert.equal(safeLabel(''), '(名前なし)');
    assert.equal(safeLabel(null), '(名前なし)');
    const long = safeLabel('あ'.repeat(200));
    assert.equal(long.length, LABEL_MAX + 1, '切った印（…）が付いていない');
    assert.ok(long.endsWith('…'));
});

test('🚨 保存が壊れていても起動できる。ただし黙って捨てない', () => {
    const bad = DeviceBook.from('{壊れた');
    assert.equal(bad.list().length, 0);
    assert.match(bad.broken ?? '', /読めません/, '壊れていたことを告げていない');

    const partial = DeviceBook.from(JSON.stringify({
        version: 1,
        devices: [{ id: 'a', hash: 'x'.repeat(64) }, { id: 'b' }],
    }));
    assert.equal(partial.list().length, 1);
    assert.match(partial.broken ?? '', /1 件/, '落とした件数を告げていない');

    // 正常な保存は broken にしない（嘘の告知を出さない）
    assert.equal(DeviceBook.from(JSON.stringify({ version: 1, devices: [] })).broken, null);
});
