// SPDX-License-Identifier: MIT
//
// 起動口と自動起動の**門と配線**を固定する（#45）。
//
// なぜ要るか: これらの門は「実行して確かめるテストが1件も無い」状態で、
// 引き継ぎのループを消しても `verify.mjs` は緑のまま通っていた。
// 特に `--allow-host` と観測フラグの引き継ぎは、落ちても**手元では気付けない**
// （再起動後だけ 403 / ログオン後だけパネルが消える）ので、ここで固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
    SERVE_FLAGS, AUTOSTART_FLAGS, unknownFlag, checkPort, checkHost,
    collectHosts, serverArgs, autostartServeArgs,
} from './serveargs.mjs';

const SERVER = '/x/v0/server.mjs';
const base = extra => serverArgs({
    argv: extra, server: SERVER, repo: '/r', port: 7749,
    tokenFile: '/s/token', auditLog: '/s/audit.jsonl',
});

test('知らないオプションは黙って捨てずに止める', () => {
    const r = unknownFlag(['--nope'], SERVE_FLAGS);
    assert.equal(r?.flag, '--nope');
    assert.equal(r.hint, '');
});

test('サーバ側の名前で打たれたら正しい名前を示す', () => {
    for (const [given, want] of Object.entries({
        '--allow-write': '--write',
        '--allow-exec': '--exec',
        '--watch-agents': '--watch',
        '--allow-transcript-text': '--agents-text',
    })) {
        const r = unknownFlag([given], SERVE_FLAGS, 'この起動口');
        assert.equal(r?.flag, given, given);
        assert.match(r.hint, new RegExp(`この起動口では ${want} です`), given);
    }
});

test('知っているオプションと値は未知として報告しない', () => {
    assert.equal(unknownFlag(['--repo', '/r', '--port', '7749', '--write'], SERVE_FLAGS), null);
    // ⚠️ 値がハイフンで始まっても値として飛ばす。ここを飛ばさないと
    //    「範囲外」を「知らないオプション」と誤って報告して原因から目を逸らす
    assert.equal(unknownFlag(['--port', '-1'], SERVE_FLAGS), null);
    assert.equal(unknownFlag(['--repo', '-weird'], SERVE_FLAGS), null);
});

test('自動起動のサブコマンドはオプションとして扱わない', () => {
    assert.equal(unknownFlag(['install', '--repo', '/r'], AUTOSTART_FLAGS), null);
    assert.equal(unknownFlag(['status'], AUTOSTART_FLAGS), null);
});

test('--port は範囲外と非数値を拒否する', () => {
    assert.equal(checkPort('7749', 1).port, 7749);
    assert.equal(checkPort(undefined, 7749).port, 7749);
    for (const bad of ['0', '65536', '99999', 'abc', '77x', '-1', ' 7749 ', '7749.0']) {
        assert.equal(checkPort(bad, 7749).error, bad, bad);
    }
});

test('--allow-host はホスト名の形だけ通す', () => {
    assert.equal(checkHost('box.example.ts.net').host, 'box.example.ts.net');
    // 空白・引用符・スラッシュが混ざると Run キーの1つの文字列の中で別の引数に化ける
    for (const bad of ['', undefined, 'a b', 'a"b', 'a/b', 'a\\b', 'a;b', '--allow-exec x']) {
        assert.notEqual(checkHost(bad).error, undefined, JSON.stringify(bad));
    }
    // 単独の `--allow-exec` はホスト名の文字だけなので通る（サーバ側の値になるだけで
    // capability にはならない）。ここで弾くべきなのは**区切りを作れる文字**
    assert.equal(checkHost('--allow-exec').error, undefined);
});

test('--allow-host は複数指定を全部集める', () => {
    const r = collectHosts(['--allow-host', 'a.ts.net', '--allow-host', 'b.ts.net']);
    assert.deepEqual(r.hosts, ['a.ts.net', 'b.ts.net']);
    assert.equal(collectHosts(['--allow-host']).error, null);
});

test('既定は読み取り専用（capability は1つも付かない）', () => {
    const a = base([]);
    assert.deepEqual(a, [SERVER, '--repo', '/r', '--port', '7749']);
});

test('--exec は --write を含むが、--write は --exec を含まない', () => {
    const w = base(['--write']);
    assert.ok(w.includes('--allow-write'));
    assert.ok(!w.includes('--allow-exec'), '--write で実行が付いてはいけない');

    const e = base(['--exec']);
    assert.ok(e.includes('--allow-write'));
    assert.ok(e.includes('--allow-exec'));
    assert.ok(e.includes('--audit-log'), '実行を許すなら監査ログを必ず付ける');
});

test('実行とトンネルはトークンを永続化する（起動ごとに変えない）', () => {
    assert.ok(base(['--exec']).includes('--token-file'));
    assert.ok(base(['--allow-host', 'box.ts.net']).includes('--token-file'));
    // 読み取り専用でループバックだけなら永続化しない（要らない場所に鍵を置かない）
    assert.ok(!base([]).includes('--token-file'));
    assert.ok(!base(['--write']).includes('--token-file'));
});

test('--allow-host は値ごとサーバに引き継ぐ（再起動後だけ 403 になる形の回帰）', () => {
    const a = base(['--allow-host', 'box.example.ts.net']);
    const i = a.indexOf('--allow-host');
    assert.notEqual(i, -1, '--allow-host が引き継がれていない');
    assert.equal(a[i + 1], 'box.example.ts.net');
});

test('観測フラグを引き継ぐ。--agents-text は --watch-agents も付ける', () => {
    assert.ok(base(['--watch']).includes('--watch-agents'));
    assert.ok(!base(['--watch']).includes('--allow-transcript-text'),
        '--watch だけで発話が出てはいけない');

    const t = base(['--agents-text']);
    assert.ok(t.includes('--allow-transcript-text'));
    // ⚠️ サーバ側が「発話フラグ単独でも観測は有効」と読むことに依存させない。
    //    依存すると、サーバの既定が変わった日に黙ってパネルが消える
    assert.ok(t.includes('--watch-agents'),
        '--agents-text は --watch-agents も明示して渡すこと');

    // 既定では観測しない（リポジトリ外を読む capability なので明示させる）
    assert.ok(!base([]).includes('--watch-agents'));
    assert.ok(!base(['--exec']).includes('--watch-agents'),
        '実行を許しても観測は別（capability をまとめない）');
});

test('自動起動は capability と引き継ぎを serve.mjs の名前で登録する', () => {
    const { args } = autostartServeArgs({ argv: ['install'], repo: 'C:/r', port: '7749' });
    assert.deepEqual(args, ['--repo', 'C:/r', '--port', '7749'],
        '既定は読み取り専用で登録する');

    const full = autostartServeArgs({
        argv: ['install', '--exec', '--allow-host', 'box.ts.net', '--agents-text'],
        repo: 'C:/r', port: '7749',
    }).args;
    assert.ok(full.includes('--exec'));
    assert.deepEqual(full.slice(full.indexOf('--allow-host'), full.indexOf('--allow-host') + 2),
        ['--allow-host', 'box.ts.net'], 'ログオン後だけ 403 になる形の回帰');
    assert.ok(full.includes('--agents-text'), 'ログオン後だけパネルが消える形の回帰');
    assert.ok(!full.includes('--write'), '--exec があるなら --write は重ねない');
});

test('自動起動は壊れたホスト名を登録しない', () => {
    const r = autostartServeArgs({
        argv: ['install', '--allow-host', 'a b'], repo: 'C:/r', port: '7749',
    });
    assert.equal(r.args, undefined);
    assert.equal(r.error, 'a b');
});

// ---- 配線（純関数だけでは「呼んでいない」を検出できない）----
// 🚨 純関数を全部テストしても、**スクリプトがそれを呼んでいなければ意味が無い**。
//    実際に起動して、門が exit 1 になることを見る。
//    ⚠️ ここで見るのは**最初に通る門**だけにする。後ろの門（--port / --allow-host）は
//       git と PowerShell を叩いてからなので、ユニットの速さを壊す（smoke の仕事）。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
function runScript(script, args) {
    return new Promise(resolve => {
        const p = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], {
            cwd: ROOT, shell: false, windowsHide: true,
            env: { ...process.env, NO_COLOR: '1' },
        });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        const t = setTimeout(() => p.kill('SIGKILL'), 20000);
        p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
        p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
    });
}

// 🚨 **門を外したときに「別の理由で 1」にならない形で測る。**
//    素の `--allow-write` だけだと、門を外した変異はそのまま**本物のサーバを起動する**
//    （テストが SIGKILL しても孫のサーバは Windows では残り、ポートを塞ぐ）。
//    到達しない repo を一緒に渡して、**門を外したら別のメッセージで落ちる**ようにする。
const NO_REPO = join(ROOT, 'no-such-directory-for-serveargs-test');

test('serve.mjs は知らないオプションで起動せずに止まる（配線）', async () => {
    const r = await runScript('serve.mjs', ['--allow-write', '--repo', NO_REPO]);
    assert.equal(r.code, 1, `起動を止めていない: ${r.out}`);
    assert.match(r.out, /知らないオプションです: --allow-write/,
        '門より先に別の検証で落ちている（門を呼んでいない）');
    assert.match(r.out, /この起動口では --write です/, '正しい名前を示していない');
});

test('autostart.mjs は知らないオプションで登録せずに止まる（配線）', async () => {
    if (process.platform !== 'win32') return;   // 非 Windows では登録経路に入らない
    // `"` を含む repo は後段で必ず弾かれる。**門が先に効いていること**を見る
    // （順序が逆なら reg を触る前に別のメッセージで落ちるので、それも検出できる）
    const r = await runScript('autostart.mjs', ['install', '--watch-agents', '--repo', 'a"b']);
    assert.equal(r.code, 1, `登録を止めていない: ${r.out}`);
    assert.match(r.out, /知らないオプションです: --watch-agents/,
        '門より先に別の検証で落ちている（門を呼んでいない）');
    assert.match(r.out, /このスクリプトでは --watch です/);
});
