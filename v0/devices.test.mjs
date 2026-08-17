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
    PAIR_ALPHABET, PAIR_LEN, pairCode, formatCode, normalizeCode,
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

test('🚨 合言葉を外したら数え、上限で要求そのものを無効にする（当てさせない）', () => {
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

/**
 * 🚨 **合言葉は日本語にしない**（利用者と検討して却下。2026-08-09）。
 *
 * エントロピーは桁で上げる方が効く（ひらがな5文字 27.6 ビット < 30種8文字 39.3 ビット）。
 * さらに日本語は **IME の切り替え / 読み間違い / 正規化（macOS の NFD）** を持ち込む。
 * ここでは「紛らわしい字が入らない」「打ちやすさを許しても強度が落ちない」を固定する。
 */
test('🚨 合言葉に紛らわしい文字が入らない（30種8文字）', () => {
    assert.equal(PAIR_ALPHABET.length, 30);
    for (const ch of '01ILOU') {
        assert.equal(PAIR_ALPHABET.includes(ch), false, `紛らわしい字が入っている: ${ch}`);
    }
    for (let i = 0; i < 200; i++) {
        const c = pairCode();
        assert.equal(c.length, PAIR_LEN);
        for (const ch of c) {
            assert.ok(PAIR_ALPHABET.includes(ch), `想定外の文字: ${ch}`);
        }
    }
});

test('合言葉は小文字・ハイフン・空白で打っても通る（強度は落ちない）', () => {
    const { b } = book();
    const r = b.request('スマホ');
    // 表示は ABCD-EFGH。打つ側は形を崩してよい
    assert.match(formatCode(r.code), /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const typed = formatCode(r.code).toLowerCase().replace('-', ' ');
    assert.equal(b.claim(r.id, typed).state, 'approved');
    // 英数字以外を落とすだけなので、別の合言葉が通るようにはならない
    assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
});

test('🚨 合言葉の分布が偏らない（剰余の偏りを作らない）', () => {
    const seen = new Map();
    const rounds = 4000;
    for (let i = 0; i < rounds; i++) {
        for (const ch of pairCode()) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
    assert.equal(seen.size, PAIR_ALPHABET.length, '出ていない文字がある（探索空間が狭い）');
    const want = (rounds * PAIR_LEN) / PAIR_ALPHABET.length;
    for (const [ch, n] of seen) {
        // 偏りの検出。剰余をそのまま使うと最初の16文字が約1.5倍になる
        assert.ok(n > want * 0.8 && n < want * 1.2,
            `${ch} の出現が ${n}（期待 ${Math.round(want)} 前後）= 偏っている`);
    }
});
