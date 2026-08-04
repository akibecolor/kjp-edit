// SPDX-License-Identifier: MIT
// node --test scripts/winargs.test.mjs
//
// 4回目のレビューの #29 / #31。**手元では踏まない**壊れ方なので、
// 空白入りのユーザ名（Windows の既定形）を想定した入力で固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winQuote, repoOf, samePathish, trimTrailingSep } from './winargs.mjs';

// 実測で使う形。バックスラッシュを直接書く（ここはソースなのでエスケープ表記でよい）
const SPACED_TRAILING = 'C:\\Users\\a b\\kjp-editor\\';
const SPACED = 'C:\\Users\\a b\\kjp-editor';

// ---------------------------------------------------------------------------
// winQuote
// ---------------------------------------------------------------------------

test('winQuote: 空白が無ければ囲まない', () => {
    assert.equal(winQuote('--port'), '--port');
    assert.equal(winQuote('C:/src/kjp-editor'), 'C:/src/kjp-editor');
});

test('winQuote: 空白があれば囲む', () => {
    assert.equal(winQuote(SPACED), `"${SPACED}"`);
    assert.equal(winQuote(''), '""');
});

// 🚨 これが #29 の本体。CRT では引用符の中の `\"` はリテラルの二重引用符なので、
//    末尾がバックスラッシュだと引用が閉じず後続の引数が飲まれる。
test('🚨 winQuote: 末尾のバックスラッシュを2倍にして引用を閉じる', () => {
    const q = winQuote(SPACED_TRAILING);
    // 末尾は `\\"` になる（`\"` ではない）
    assert.ok(q.endsWith('\\\\"'), `引用が閉じていない: ${q}`);
    assert.ok(!q.endsWith('\\\\\\"'), `過剰にエスケープしている: ${q}`);
    // 素朴な実装との違いを明示する
    assert.notEqual(q, `"${SPACED_TRAILING}"`);
});

test('winQuote: 値の中の引用符をエスケープする', () => {
    // `a "b" c` → `"a \"b\" c"`
    assert.equal(winQuote('a "b" c'), '"a \\"b\\" c"');
    // 引用符の直前のバックスラッシュも2倍にする
    assert.equal(winQuote('a\\"b c'), '"a\\\\\\"b c"');
});

test('winQuote: 文字列以外は受け取らない（黙って壊れない）', () => {
    assert.throws(() => winQuote(null), TypeError);
    assert.throws(() => winQuote(42), TypeError);
});

// ---------------------------------------------------------------------------
// repoOf
// ---------------------------------------------------------------------------

// 🚨 これが #31 の本体。`(\S+)` だと引用の途中で切れる。
test('🚨 repoOf: 引用された空白入りのパスを丸ごと取る', () => {
    const cmd = 'C:\\node.exe v0/server.mjs --repo "C:/Users/a b/repo" --port 7900';
    assert.equal(repoOf(cmd), 'C:/Users/a b/repo');
    // 素朴な `(\S+)` が取る値との違い
    assert.notEqual(repoOf(cmd), '"C:/Users/a');
});

test('repoOf: 引用が無い場合も取れる', () => {
    assert.equal(
        repoOf('node v0/server.mjs --repo C:/src/repo --port 7749 --allow-write'),
        'C:/src/repo',
    );
});

test('repoOf: --repo が無ければ null', () => {
    assert.equal(repoOf('node v0/server.mjs --port 7749'), null);
    assert.equal(repoOf(null), null);
    assert.equal(repoOf(''), null);
});

test('repoOf: 後続のフラグを飲み込まない', () => {
    const cmd = 'node serve.mjs --repo "C:/a b/repo" --port 7749 --allow-host box.example.ts.net';
    assert.equal(repoOf(cmd), 'C:/a b/repo');
    assert.ok(!repoOf(cmd).includes('--port'), '後続のフラグが混ざっている');
});

// ---------------------------------------------------------------------------
// samePathish / trimTrailingSep
// ---------------------------------------------------------------------------

test('samePathish: 区切り・大文字小文字・末尾セパレータを吸収する', () => {
    assert.ok(samePathish('C:\\a b\\repo', 'C:/a b/repo'));
    assert.ok(samePathish('C:/A B/Repo', 'c:/a b/repo'));
    assert.ok(samePathish('C:/a/repo/', 'C:/a/repo'));
    assert.ok(!samePathish('C:/a/repo', 'C:/a/repo2'));
    assert.ok(!samePathish('', 'C:/a'));
    assert.ok(!samePathish(null, 'C:/a'));
});

test('trimTrailingSep: 末尾のセパレータだけを落とす', () => {
    assert.equal(trimTrailingSep(SPACED_TRAILING), SPACED);
    assert.equal(trimTrailingSep('C:/a/b//'), 'C:/a/b');
    assert.equal(trimTrailingSep('C:/a/b'), 'C:/a/b');
});
