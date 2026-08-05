// SPDX-License-Identifier: MIT
// node --test v0/argv.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgv, isChatArgv } from './argv.mjs';

const a = s => splitArgv(s).argv;

test('普通の分割', () => {
    assert.deepEqual(a('git status --short'), ['git', 'status', '--short']);
    assert.deepEqual(a('  git   status  '), ['git', 'status']);
    assert.deepEqual(a(''), []);
    assert.deepEqual(a('   '), []);
});

test('クォートで空白を含む引数', () => {
    assert.deepEqual(a('git commit -m "a b"'), ['git', 'commit', '-m', 'a b']);
    assert.deepEqual(a('git commit -m "a b" "c d"'), ['git', 'commit', '-m', 'a b', 'c d']);
    assert.deepEqual(a("git log --pretty=format:'%h %s'"),
        ['git', 'log', '--pretty=format:%h %s']);
});

test('空文字列の引数を取れる', () => {
    assert.deepEqual(a('git commit -m ""'), ['git', 'commit', '-m', '']);
    assert.deepEqual(a("echo ''"), ['echo', '']);
});

test('隣接したクォートは連結される（sh と同じ）', () => {
    assert.deepEqual(a('a"b"c'), ['abc']);
    assert.deepEqual(a('echo a"" b'), ['echo', 'a', 'b']);
});

// 🚨 レビューで見つかった穴。`don't` のアポストロフィがクォート開始と
//    解釈され、閉じないまま行末まで飲み込んで3語が1引数に融合していた。
test('regression: アポストロフィで語が融合しない（閉じないクォートを警告する）', () => {
    const r = splitArgv("git commit -m don't panic now");
    assert.ok(r.warning, '閉じていないクォートが警告されていない');
    assert.match(r.warning, /閉じていません/);
});

// 🚨 エスケープ機構が無く `"say \"hi\""` が `say \hi\` になっていた。
test('regression: ダブルクォート内のエスケープが効く', () => {
    assert.deepEqual(a('git commit -m "say \\"hi\\""'), ['git', 'commit', '-m', 'say "hi"']);
    assert.deepEqual(a('echo "a\\\\b"'), ['echo', 'a\\b']);
});

// ⚠️ Windows のパスを壊さないこと。クォートの外では `\` をエスケープとして扱わない。
test('regression: Windows のパスのバックスラッシュが消えない', () => {
    assert.deepEqual(a('C:\\a\\b\\c.txt'), ['C:\\a\\b\\c.txt']);
    assert.deepEqual(a('cmd /c type C:\\tmp\\x.txt'),
        ['cmd', '/c', 'type', 'C:\\tmp\\x.txt']);
    // クォート内でも、エスケープ対象でない文字の前の `\` は残す
    assert.deepEqual(a('cmd /c "C:\\Program Files\\x.exe"'),
        ['cmd', '/c', 'C:\\Program Files\\x.exe']);
});

test('閉じているクォートには警告を出さない', () => {
    assert.equal(splitArgv('git commit -m "ok"').warning, null);
    assert.equal(splitArgv('git status').warning, null);
});

test('シングルクォート内ではエスケープしない（sh と同じ）', () => {
    assert.deepEqual(a("echo 'a\\b'"), ['echo', 'a\\b']);
});

/**
 * 🚨 **会話モードの判定を argv から復元できること。**
 *
 * 再接続で `chat` を渡していなかったので、次の送信で生のテキストが stdin に書かれ、
 * `claude --input-format stream-json` が即 exit 1 で死んでいた（会話が丸ごと消える）。
 * サーバは argv を返すので、**argv を根拠にすれば再接続でも復元できる**。
 */
test('isChatArgv: --input-format stream-json を会話モードとして見分ける', () => {
    assert.equal(isChatArgv(['claude', '-p', '--input-format', 'stream-json',
        '--output-format', 'stream-json']), true);
    assert.equal(isChatArgv(['claude', '-p', '--input-format=stream-json']), true);
    // 出力だけ stream-json なのは会話モードではない（stdin は生のまま）
    assert.equal(isChatArgv(['claude', '-p', '--output-format', 'stream-json']), false);
    assert.equal(isChatArgv(['npm', 'test']), false);
    assert.equal(isChatArgv(['claude', '--input-format']), false, '値が無い形で落ちない');
    assert.equal(isChatArgv(['claude', '--input-format', 'text']), false);
    // 壊れた入力で投げない（サーバ由来の値をそのまま渡すので）
    for (const bad of [null, undefined, 'string', 42, {}]) {
        assert.equal(isChatArgv(bad), false, JSON.stringify(bad));
    }
});
