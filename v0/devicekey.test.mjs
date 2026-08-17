// SPDX-License-Identifier: MIT
// node --test v0/devicekey.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pickCredential, canMutateWith, deviceLabel, DEVICE_KEY, URL_KEY,
} from './devicekey.mjs';

test('🚨 貼った鍵を優先する（貼ったのに効かないを作らない）', () => {
    assert.deepEqual(pickCredential({ sessionToken: 'PASTED', deviceKey: 'DEV' }),
        { value: 'PASTED', kind: 'pasted' });
    assert.deepEqual(pickCredential({ sessionToken: null, deviceKey: 'DEV' }),
        { value: 'DEV', kind: 'device' });
    assert.deepEqual(pickCredential({ sessionToken: '  ', deviceKey: '' }),
        { value: null, kind: 'none' });
    assert.equal(pickCredential().kind, 'none');
});

test('🚨 前に URL で来た鍵は端末の鍵より弱い（実測で踏んだ回帰）', () => {
    // 案内 URL の `?token=` を貼った鍵と同じ枠に入れていたので、
    // 承認済みの端末で「実行有効（トークン未取得）」になった。
    assert.deepEqual(pickCredential({ deviceKey: 'DEV', storedUrlToken: 'READ' }),
        { value: 'DEV', kind: 'device' }, '保存された URL の鍵が端末の鍵に勝っている');
    // 端末の鍵が無ければ使う（読めなくなっては困る）
    assert.deepEqual(pickCredential({ storedUrlToken: 'READ' }),
        { value: 'READ', kind: 'stored' });
    // 枠が同じだと、この区別そのものが成立しない
    assert.notEqual(URL_KEY, DEVICE_KEY);
});

test('🚨 今 URL で来た鍵は最優先（失効した端末の鍵に閉じ込められない）', () => {
    // ⚠️ **ここが「実行を取り戻す道」。** 端末の鍵より下に置くと、失効した鍵を
    //    握った画面が鍵つき URL を開き直しても死んだ鍵を送り続け、
    //    利用者から見ると「もう実行を戻せない」になる
    //    （この順序があるので、死んだ鍵を捨てる処理は要らない。devicekey.mjs 末尾）。
    assert.deepEqual(
        pickCredential({ urlToken: 'FRESH', sessionToken: 'P', deviceKey: 'D', storedUrlToken: 'S' }),
        { value: 'FRESH', kind: 'url' },
    );
    // 空白だけは「来ていない」と同じ
    assert.equal(pickCredential({ urlToken: '   ', deviceKey: 'D' }).kind, 'device');
});

test('🚨 端末の鍵でも capability の UI が使える（device を落とさない）', () => {
    assert.equal(canMutateWith('token'), true);
    assert.equal(canMutateWith('device'), true, '承認した端末で「トークン未取得」になる');
    // ⚠️ 読み取り用は使えない（混ぜると「有効に見えて必ず 403」）
    assert.equal(canMutateWith('read'), false);
    assert.equal(canMutateWith('none'), false);
    assert.equal(canMutateWith(undefined), false);
});

test('deviceLabel: 短い名前にする。分からなければ「不明」と言う', () => {
    assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537'),
        'Android / Chrome');
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604'), 'iOS / Safari');
    assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Edg/126'), 'Windows / Edge');
    // 🚨 推測して間違った名前を出すより、分からないと言う
    assert.equal(deviceLabel('', ''), '不明な端末');
    assert.equal(deviceLabel(null, 'Wii'), '不明な端末（Wii）');
});

test('保存先のキーは固定（変えると登録済みの端末が黙って無効になる）', () => {
    assert.equal(DEVICE_KEY, 'kjp.device');
    assert.equal(URL_KEY, 'kjp_url');
});
