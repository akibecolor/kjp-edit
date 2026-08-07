// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseProcPairs, descendantsOf, stillAlive } from './proctree.mjs';
import * as winargs from '../scripts/winargs.mjs';

// 🚨 **実装が1つであることを検査で固定する。** 以前は `scripts/winargs.mjs` にしか
//    無く、サーバ側の `killTree()` は直接の子しか数え直していなかった
//    （木から外れた孫が生きているのに「停止しました」と言っていた）。
//    片方にコピーが増えると、片方だけ直して片方が古いままになる。
test('proctree: 実装は1つ（winargs は再エクスポート）', () => {
    assert.equal(winargs.parseProcPairs, parseProcPairs);
    assert.equal(winargs.descendantsOf, descendantsOf);
    assert.equal(winargs.stillAlive, stillAlive);
});

test('stillAlive: 生きている pid だけを返す（差し替えた probe で）', () => {
    const seen = [];
    const probe = pid => { seen.push(pid); return pid % 2 === 0; };
    assert.deepEqual(stillAlive([1, 2, 3, 4], probe), [2, 4]);
    assert.deepEqual(seen, [1, 2, 3, 4], '全部を確かめていない');
});

// ⚠️ 0 や負値を `process.kill` に渡すと意味が変わる（0 は自分のプロセスグループ、
//    負値はグループ）。**数え直しで自分自身やグループ全体を「生きている」と
//    数えてはいけない**ので、入口で落とす。
test('stillAlive: 0 / 負値 / 整数でない値は数えない', () => {
    const probe = () => true;
    assert.deepEqual(stillAlive([0, -1, 1.5, NaN, null, undefined, '7'], probe), []);
    assert.deepEqual(stillAlive(null, probe), []);
});

test('stillAlive: 実在しない pid は生きていないと数える', () => {
    // 使われていないであろう大きな pid（Linux の既定上限 4194304 を超える値）
    assert.deepEqual(stillAlive([4194305 + 1]), []);
    assert.deepEqual(stillAlive([process.pid]), [process.pid],
        '自分のプロセスを「生きていない」と数えた');
});

test('stillAlive: 終了した実プロセスを生きていると数えない', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    assert.ok(pid > 0);
    await new Promise(r => child.on('exit', r));
    // ⚠️ 回収（wait）が済むまでは POSIX で zombie として残るので少し待つ
    for (let i = 0; i < 30 && stillAlive([pid]).length; i++) {
        await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(stillAlive([pid]), [],
        `終了した pid ${pid} を生きていると数えた（数え直しが常に失敗する）`);
});

test('descendantsOf: 木を全部辿る / 循環で止まらない', () => {
    const pairs = parseProcPairs('10\t1\n11\t10\n12\t11\n13\t10\n99\t50\n');
    assert.deepEqual(descendantsOf(pairs, 10).sort((a, b) => a - b), [11, 12, 13]);
    assert.deepEqual(descendantsOf(pairs, 12), []);
    // pid が再利用されると親子関係が輪を作りうる（死んだ親の pid を新しいプロセスが持つ）
    const cyclic = parseProcPairs('20\t21\n21\t20\n');
    assert.deepEqual(descendantsOf(cyclic, 20), [21]);
});
