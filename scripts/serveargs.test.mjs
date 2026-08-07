// SPDX-License-Identifier: MIT
//
// 起動口と自動起動の**門と配線**を固定する（#45）。
//
// なぜ要るか: これらの門は「実行して確かめるテストが1件も無い」状態で、
// 引き継ぎのループを消しても `verify.mjs` は緑のまま通っていた。
// 特に `--allow-host` と観測フラグの引き継ぎは、落ちても**手元では気付けない**
// （再起動後だけ 403 / ログオン後だけパネルが消える）ので、ここで固定する。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import {
    SERVE_FLAGS, AUTOSTART_FLAGS, unknownFlag, checkPort, checkHost,
    collectHosts, collectRepos, serverArgs, autostartServeArgs, checkTimeout, timeoutFrom,
    runningCaps, requestedCaps, describeCaps,
    runningConfig, requestedConfig, configDiff, stopTargets, stopOutcome,
    otherDaemonsNote, portShiftNote, shouldWriteReadSecret,
} from './serveargs.mjs';

const SERVER = '/x/v0/server.mjs';
const base = extra => serverArgs({
    argv: extra, server: SERVER, repos: ['/r'], port: 7749,
    tokenFile: '/s/token-read', writeTokenFile: '/s/token-write',
    execTokenFile: '/s/token-exec', auditLog: '/s/audit.jsonl',
});
/** args から --token-file の値を取る。無ければ null
 *  ⚠️ `indexOf` が -1 のときに +1 して 0 にしない（args[0] を値と誤読する） */
const tokenFileOf = a => {
    const i = a.indexOf('--token-file');
    return i === -1 ? null : (a[i + 1] ?? null);
};

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
    // ⚠️ `--audit-log` は capability ではない（記録の置き場所）。
    //    どの構成でも渡す（401 の記録は --require-auth から出るため）。
    assert.deepEqual(a, [SERVER, '--repo', '/r', '--port', '7749',
        '--audit-log', '/s/audit.jsonl']);
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

/**
 * 🚨 **8回目のレビュー: 記録の置き場所は capability に関係なく渡す。**
 *
 * 401（認証失敗）は `--require-auth` を付けた瞬間から記録されるので、
 * 「実行を許したときだけ記録が出る」という前提は既に成り立っていない。
 * `--exec` のときだけ `--audit-log` を渡していたので、**常用構成
 * （読み取り専用 + `--allow-host`）では記録を `.git` の外に出す手段が無かった**
 * — つまりトンネルに出している間、tailnet の全端末が自分の `.git` の中の
 * ファイルを無認証で伸ばせる状態だった。
 */
test('監査ログの置き場所はどの capability でも渡す', () => {
    for (const argv of [[], ['--write'], ['--allow-host', 'box.ts.net'], ['--exec']]) {
        const a = base(argv);
        assert.ok(a.includes('--audit-log'),
            `${argv.join(' ') || '(既定)'} で監査ログの置き場所を渡していない`);
        assert.equal(a[a.indexOf('--audit-log') + 1], '/s/audit.jsonl');
    }
});

test('実行とトンネルはトークンを永続化する（起動ごとに変えない）', () => {
    assert.ok(base(['--exec']).includes('--token-file'));
    assert.ok(base(['--allow-host', 'box.ts.net']).includes('--token-file'));
    // 読み取り専用でループバックだけなら永続化しない（要らない場所に鍵を置かない）
    assert.ok(!base([]).includes('--token-file'));
    assert.ok(!base(['--write']).includes('--token-file'));
});

/**
 * 🚨 **読み取り用と実行用のトークンを同じ値にしない。**
 *
 * 以前は同じ `~/.kjp-edit/token` を両方に渡していたので、
 * `serve.mjs --allow-host box.ts.net`（読み取り専用）が案内する `?token=…` は
 * `serve.mjs --exec` のデーモンが受け付ける値と**バイト一致**していた。
 * つまり「スマホで読み取り用の URL を1回開く」ことが、**実行トークンを
 * 携帯のブラウザ・URL 履歴・トンネルのアクセスログに置く**ことと同義だった
 * （Cookie に実行トークンを入れていたのと同じクラスの再発。6回目のレビュー）。
 */
test('🔒 読み取り用トンネルと実行でトークンのファイルを分ける', () => {
    const read = tokenFileOf(base(['--allow-host', 'box.ts.net']));
    const exec = tokenFileOf(base(['--exec']));
    assert.equal(read, '/s/token-read');
    assert.equal(exec, '/s/token-exec');
    assert.notEqual(read, exec,
        '読み取り用の URL を配ると実行トークンを配ることになる');

    // 実行 + トンネルなら実行用（強い方）を使う。読み取り用に降格させない
    assert.equal(tokenFileOf(base(['--exec', '--allow-host', 'box.ts.net'])), '/s/token-exec');
    // 🚨 **--write --allow-host も読み取り用と別の値にする。** 6回目に分けたのは
    //    exec だけだったので、書き込みデーモンが読み取り専用トンネルと同じ
    //    token-read を使っていた（読み取り用として配ったトークンが checkout の
    //    資格情報になる）。**この検査は以前その穴を承認していた**（7回目のレビュー）
    assert.equal(tokenFileOf(base(['--write', '--allow-host', 'box.ts.net'])), '/s/token-write');
    assert.notEqual(tokenFileOf(base(['--write', '--allow-host', 'box.ts.net'])),
        tokenFileOf(base(['--allow-host', 'box.ts.net'])));
    // ループバックだけなら永続化しない（要らない場所に鍵を置かない）
    assert.equal(tokenFileOf(base(['--write'])), null);
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
    const { args } = autostartServeArgs({ argv: ['install'], repos: ['C:/r'], port: '7749' });
    assert.deepEqual(args, ['--repo', 'C:/r', '--port', '7749'],
        '既定は読み取り専用で登録する');

    const full = autostartServeArgs({
        argv: ['install', '--exec', '--allow-host', 'box.ts.net', '--agents-text'],
        repos: ['C:/r'], port: '7749',
    }).args;
    assert.ok(full.includes('--exec'));
    assert.deepEqual(full.slice(full.indexOf('--allow-host'), full.indexOf('--allow-host') + 2),
        ['--allow-host', 'box.ts.net'], 'ログオン後だけ 403 になる形の回帰');
    assert.ok(full.includes('--agents-text'), 'ログオン後だけパネルが消える形の回帰');
    assert.ok(!full.includes('--write'), '--exec があるなら --write は重ねない');
});

test('自動起動は壊れたホスト名を登録しない', () => {
    const r = autostartServeArgs({
        argv: ['install', '--allow-host', 'a b'], repos: ['C:/r'], port: '7749',
    });
    assert.equal(r.args, undefined);
    assert.equal(r.error, 'a b');
});

/* ---- 複数リポジトリ（`--repo` を複数回） ----
 *
 * 🚨 引き継ぎが落ちても**手元では気付けない**（起動口では2本見えるのに、
 *    ログオン後は1本になっている）。`--allow-host` / `--timeout` と同じ形なので
 *    純関数で固定する。
 */
test('--repo の値を全部集める（1本目だけ読んで捨てない）', () => {
    assert.deepEqual(collectRepos(['--repo', 'C:/a', '--repo', 'C:/b']).repos,
        ['C:/a', 'C:/b'], '2本目を捨てている');
    assert.deepEqual(collectRepos([]).repos, [], '指定が無ければ空（呼び出し側が既定を決める）');
    // 順序は「1本目が既定」の意味を持つので保つ
    assert.deepEqual(collectRepos(['--repo', 'C:/z', '--port', '1', '--repo', 'C:/a']).repos,
        ['C:/z', 'C:/a']);
});

test('--repo の壊れた値を通さない（Run キーの引用が閉じなくなる）', () => {
    for (const bad of [['--repo'], ['--repo', ''], ['--repo', '--port'],
        ['--repo', 'C:/a"b'], ['--repo', 'C:/a\nb']]) {
        const r = collectRepos(bad);
        assert.equal(r.repos, undefined, `通ってしまった: ${JSON.stringify(bad)}`);
        assert.ok('error' in r, `error を返していない: ${JSON.stringify(bad)}`);
    }
});

test('🔒 複数の --repo をサーバに全部渡す（読める範囲は起動時に固定する）', () => {
    const args = serverArgs({
        argv: [], server: SERVER, repos: ['/a', '/b', '/c'], port: 7749,
        tokenFile: '/s/token-read', writeTokenFile: '/s/token-write',
        execTokenFile: '/s/token-exec', auditLog: '/s/audit.jsonl',
    });
    const repos = args.map((a, i) => (a === '--repo' ? args[i + 1] : null)).filter(Boolean);
    assert.deepEqual(repos, ['/a', '/b', '/c'], '本数が落ちている');
    // 1本目が既定なので順序が意味を持つ
    assert.equal(args[args.indexOf('--repo') + 1], '/a');
});

test('🚨 自動起動の登録に --repo を全部引き継ぐ（ログオン後だけ1本に戻らない）', () => {
    const { args } = autostartServeArgs({
        argv: ['install'], repos: ['C:/a', 'C:/b'], port: '7749',
    });
    const repos = args.map((a, i) => (a === '--repo' ? args[i + 1] : null)).filter(Boolean);
    assert.deepEqual(repos, ['C:/a', 'C:/b'], '再起動後だけ1本になる形の回帰');
});

test('repos を配列で渡し忘れたら黙って通さない', () => {
    // 単数の `repo` を渡すと `--repo undefined` になり「別の場所を見ている」で
    // 気付くことになる。起動前に止める
    assert.throws(() => serverArgs({
        argv: [], server: SERVER, repo: '/a', port: 7749,
    }), /repos/);
    assert.throws(() => autostartServeArgs({ argv: [], repo: '/a', port: 1 }), /repos/);
});


/**
 * 🚨 **本物の `~/.kjp-edit/` を触っていないことを検査で固定する（#56）。**
 *
 * 「一時 HOME を渡す」だけでは、渡し忘れた経路が増えたときに気付けない。
 * 鍵と `last.json` の mtime を前後で比べる。
 * ⚠️ `exec-audit.jsonl` は**動いているデーモンが正しく追記する**ので見ない
 *    （見ると「別の理由で落ちる」検査になる）。
 */
const STATE_DIR = join(homedir(), '.kjp-edit');
const WATCHED = ['token-read', 'token-write', 'token-exec', 'last.json'];
const stampState = async () => {
    const out = {};
    for (const name of WATCHED) {
        out[name] = await stat(join(STATE_DIR, name))
            .then(st => `${st.mtimeMs}:${st.size}`, () => null);
    }
    return out;
};
let stateBefore = null;
before(async () => {
    scratchHome = await mkdtemp(join(tmpdir(), 'kjp-args-home-'));
    stateBefore = await stampState();
});
after(async () => {
    const now = await stampState();
    const changed = WATCHED.filter(n => stateBefore[n] !== now[n]);
    if (scratchHome) await rm(scratchHome, { recursive: true, force: true }).catch(() => {});
    assert.deepEqual(changed, [],
        `検査が本物の ${STATE_DIR} を書き換えた（#56）: ${changed.join(', ')}。`
        + ' 子を起こす経路に一時 HOME を渡し忘れていないか確認すること'
        + '（同じ場所に実行トークンがある）');
});
// ---- 配線（純関数だけでは「呼んでいない」を検出できない）----
// 🚨 純関数を全部テストしても、**スクリプトがそれを呼んでいなければ意味が無い**。
//    実際に起動して、門が exit 1 になることを見る。
//    ⚠️ ここで見るのは**最初に通る門**だけにする。後ろの門（--port / --allow-host）は
//       git と PowerShell を叩いてからなので、ユニットの速さを壊す（smoke の仕事）。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * 🚨 **子は既定で一時 HOME を見る（#56）。**
 *
 * 以前は `env` を渡さない呼び出しが**本物の HOME を継承**していたので、
 * `~/.kjp-edit/last.json` に検査の一時リポジトリが書かれていた（実測）。
 * 同じディレクトリに `token-read` / `token-write` / `token-exec` があるので、
 * **書ける経路がある**こと自体が危ない（鍵が変わればスマホから繋がらない）。
 * ⚠️ 呼び出し側の意志に任せない。**入口で既定にする**（仕組みで防ぐ）。
 */
let scratchHome = null;
/**
 * 🚨 **子に渡す環境は1箇所で組む（#56）。**
 *
 * 「一時 HOME を渡す」処理が2箇所あると、片方を外しても検査が落ちない
 * = 守りが検証されない（実際にこの形で変異が SURVIVED し、
 *   変異の `from` も2箇所に一致して STALE になった）。
 * `os.homedir()` は Windows で USERPROFILE、POSIX で HOME を見るので両方渡す。
 */
function childEnv(extra = {}) {
    return {
        ...process.env, NO_COLOR: '1',
        ...(scratchHome ? { HOME: scratchHome, USERPROFILE: scratchHome } : {}),
        ...extra,
    };
}
function runScript(script, args, env = {}) {
    return new Promise(resolve => {
        const p = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], {
            cwd: ROOT, shell: false, windowsHide: true,
            env: childEnv(env),
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

/**
 * 🚨 **「既に動いています」で URL だけ出してはいけない。**
 *
 * 先に `--exec` のデーモンが動いていると、素の `node scripts/serve.mjs`
 * （読み取り専用のつもり）が「既に動いています → URL」と出して exit 0 し、
 * **案内した先が RCE 可能なデーモンであることを1文字も言わなかった**（7回目のレビュー）。
 */
test('🔒 動いているデーモンの capability を読める（実行を黙って案内しない）', () => {
    const execCmd = 'node C:/x/v0/server.mjs --repo C:/r --port 7749'
        + ' --allow-write --allow-exec --watch-agents --allow-host box.ts.net';
    assert.deepEqual(runningCaps(execCmd).sort(),
        ['--allow-exec', '--allow-host', '--allow-write', '--watch-agents']);
    assert.match(describeCaps(execCmd), /実行/, '実行が有効なことを言っていない');
    assert.match(describeCaps(execCmd), /Host許可: box.ts.net/);

    const roCmd = 'node C:/x/v0/server.mjs --repo C:/r --port 7749';
    assert.deepEqual(runningCaps(roCmd), []);
    assert.match(describeCaps(roCmd), /読み取り専用/);
    assert.match(describeCaps(roCmd), /ループバックのみ/, 'Host 許可の有無を言っていない');

    // ⚠️ 部分一致で誤検出しない（`--allow-hostx` を `--allow-host` と読まない）
    assert.deepEqual(runningCaps('node v0/server.mjs --allow-hostx y'), []);
});

test('要求した capability をサーバ側の名前に直せる（差分を出すため）', () => {
    assert.deepEqual(requestedCaps(['--exec']).sort(), ['--allow-exec', '--allow-write']);
    assert.deepEqual(requestedCaps(['--write']), ['--allow-write']);
    assert.deepEqual(requestedCaps(['--agents-text']).sort(),
        ['--allow-transcript-text', '--watch-agents']);
    assert.deepEqual(requestedCaps(['--watch']), ['--watch-agents']);
    assert.deepEqual(requestedCaps(['--allow-host', 'a.ts.net']), ['--allow-host']);
    assert.deepEqual(requestedCaps([]), []);
    assert.deepEqual(requestedCaps(null), [], '壊れた入力で投げない');

    // 読み取り専用のデーモンが動いている状態で --exec を要求したら差分が出る
    const missing = requestedCaps(['--exec'])
        .filter(c => !runningCaps('node v0/server.mjs --repo C:/r').includes(c));
    assert.deepEqual(missing.sort(), ['--allow-exec', '--allow-write'],
        '黙って無視すると「打ったのに効かない」状態になる');
});

/* ===== 実行セッションの絶対上限（--timeout） =====
   🚨 既定 600 秒はエージェントの仕事に足りない（実測: Bash/Read を20回する仕事が
      551 秒でまだ走っていた）。常用の起動口から延ばせないと、
      「回答が書かれる直前に SIGKILL」が繰り返し起きる。 */

test('🚨 --timeout で絶対上限をサーバに渡す', () => {
    const a = serverArgs({
        argv: ['--exec'], server: SERVER, repos: ['/r'], port: 7749,
        tokenFile: '/s/token-read', writeTokenFile: '/s/token-write',
        execTokenFile: '/s/token-exec', auditLog: '/s/audit.jsonl',
        execTimeout: 3600,
    });
    const i = a.indexOf('--exec-timeout');
    assert.notEqual(i, -1, `渡していない: ${a.join(' ')}`);
    assert.equal(a[i + 1], '3600');
});

test('--timeout を指定しなければサーバの既定に任せる（勝手に決めない）', () => {
    assert.equal(base(['--exec']).includes('--exec-timeout'), false);
});

test('🚨 --timeout の値を検証する（上限そのものは外せない）', () => {
    assert.deepEqual(checkTimeout(undefined), { seconds: null });
    assert.deepEqual(checkTimeout(''), { seconds: null });
    assert.deepEqual(checkTimeout('3600'), { seconds: 3600 });
    for (const bad of ['0', '5', '-1', 'abc', '10.5', '86401', 'none', 'infinite']) {
        assert.ok(checkTimeout(bad).error !== undefined, `通してはいけない: ${bad}`);
    }
});

test('--timeout は起動口と自動起動の両方が受け付ける（片方だけにしない）', () => {
    assert.ok(SERVE_FLAGS.has('--timeout'));
    assert.ok(AUTOSTART_FLAGS.has('--timeout'), '自動起動で落ちると再起動後だけ短くなる');
    // 値を取るフラグとして登録されていないと、値が「知らないフラグ」に見える
    assert.equal(unknownFlag(['--timeout', '3600'], SERVE_FLAGS), null);
});

test('🚨 自動起動の登録に --timeout を引き継ぐ（再起動後だけ短くならない）', () => {
    const r = autostartServeArgs({ argv: ['--exec', '--timeout', '3600'], repos: ['/r'], port: 7749 });
    assert.deepEqual(r.error, undefined);
    const i = r.args.indexOf('--timeout');
    assert.notEqual(i, -1, `引き継いでいない: ${r.args.join(' ')}`);
    assert.equal(r.args[i + 1], '3600');
});

test('🚨 --timeout の値が無い形を既定に落とさない', () => {
    assert.deepEqual(timeoutFrom(['--exec', '--timeout', '3600']), { seconds: 3600 });
    assert.deepEqual(timeoutFrom(['--exec']), { seconds: null });
    assert.deepEqual(timeoutFrom([]), { seconds: null });
    assert.deepEqual(timeoutFrom(null), { seconds: null }, '壊れた入力で投げない');
    // 🚨 値を忘れた形。以前の `val()` は次のトークンが無いと**既定に落ちていた**ので、
    //    「上限を延ばしたつもりで 600 秒のまま起動」になっていた
    assert.notEqual(timeoutFrom(['--exec', '--timeout']).error, undefined, '値なしを通した');
    assert.notEqual(timeoutFrom(['--timeout', '--exec']).error, undefined, '次のフラグを値と読んだ');
    assert.equal(timeoutFrom(['--timeout', '5']).error, '5', '範囲の検証を通っていない');
});

/* ===== 「既に動いています」の差分（8回目のレビュー） =====
   🚨 capability の**名前**しか比べていなかったので、`--timeout` は集合に入らず
      `--allow-host` は値を見ていなかった。`--timeout 3600` を付けて起動し直したつもりが
      「既に動いています → URL」で exit 0 になり、**前のデーモンが 600 秒のまま**
      走り続けていた（実測 551 秒でまだ走っていた仕事が、この経路で無言で旧設定に戻る）。 */

const RUNNING_EXEC = 'node C:/x/v0/server.mjs --repo C:/r --port 7749 --allow-write'
    + ' --allow-exec --token-file C:/s/token-exec --audit-log C:/s/a.jsonl'
    + ' --exec-timeout 3600 --allow-host box-a.ts.net';

test('動いているデーモンの設定を値まで読む（上限と許可ホスト）', () => {
    const c = runningConfig(RUNNING_EXEC);
    assert.equal(c.execTimeout, 3600);
    assert.deepEqual(c.hosts, ['box-a.ts.net']);
    // --exec-timeout が無ければ「サーバの既定」= null。0 と混同しない
    assert.equal(runningConfig('node v0/server.mjs --allow-exec').execTimeout, null);
    // ⚠️ 部分一致で拾わない
    assert.equal(runningConfig('node v0/server.mjs --exec-timeoutx 99').execTimeout, null);
    assert.deepEqual(runningConfig('node v0/server.mjs --allow-hostx y').hosts, []);
    assert.equal(runningConfig(null).execTimeout, null, '壊れた入力で投げない');
});

test('🚨 「既に動いています」の差分は値まで見る（上限とホスト）', () => {
    // (1) 上限だけが違う。以前はここが missing=[] で **exit 0 = 黙って無効**だった
    const t = configDiff(['--exec', '--timeout', '7200'], RUNNING_EXEC);
    assert.equal(t.length, 1, `上限の違いを1件だけ出すこと: ${JSON.stringify(t)}`);
    assert.equal(t[0].what, '--exec-timeout');
    assert.match(t[0].want, /7200/);
    assert.match(t[0].have, /3600/);

    // (2) ホストが違う（c0948ea の「再起動後だけ 403」と同型。名前だけでは同じに見える）
    const h = configDiff(['--exec', '--timeout', '3600', '--allow-host', 'box-b.ts.net'],
        RUNNING_EXEC);
    assert.deepEqual(h.map(d => d.what), ['--allow-host']);
    assert.match(h[0].have, /box-a\.ts\.net/, '動いている許可ホストを出していない');

    // (3) 同じ設定なら差分は無い（毎回止めさせる形にはしない）
    assert.deepEqual(configDiff(['--exec', '--timeout', '3600', '--allow-host', 'BOX-A.ts.net'],
        RUNNING_EXEC), [], 'ホスト名は大文字小文字を区別しない');
    assert.deepEqual(configDiff(['--exec'], RUNNING_EXEC), [],
        '上限を要求していないのに差分を出してはいけない');

    // (4) capability の差分は今まで通り出す（読み取り専用のデーモンに --exec を要求）
    assert.deepEqual(configDiff(['--exec'], 'node v0/server.mjs --repo C:/r').map(d => d.what)
        .sort(), ['--allow-exec', '--allow-write']);

    // (5) 上限は --exec と一緒でなければサーバに渡らないので要求として数えない
    assert.deepEqual(configDiff(['--timeout', '7200'], 'node v0/server.mjs --repo C:/r'), []);
    assert.equal(requestedConfig(['--timeout', '7200']).execTimeout, null);
});

/* 🚨 リポジトリの本数も「値まで見る」対象。
 *
 * 二重起動の判定は**1本目**（`repoOf`）でしているので、これが無いと
 * `--repo A --repo B` を打った人に「既に動いています（A のデーモン）」と答えて
 * exit 0 し、**B が見えないことを1文字も言わない**（`--timeout` を集合に
 * 入れていなかったのと同型の穴）。
 */
test('🚨 configDiff は要求したリポジトリが全部見えているかを見る', () => {
    const oneRepo = 'node v0/server.mjs --repo C:/one --port 7749';
    // (1) 2本目が見えていないなら差分として出す（= 入れ直させる）
    const d = configDiff([], oneRepo, { repos: ['C:/one', 'C:/two'] });
    assert.deepEqual(d.map(x => x.what), ['--repo'],
        `2本目が見えないことを黙っている: ${JSON.stringify(d)}`);
    assert.equal(d[0].want, 'C:/two');
    assert.match(d[0].have, /C:\/one/, '動いているリポジトリを出していない');

    // (2) 全部見えているなら差分なし（毎回止めさせる形にはしない）
    assert.deepEqual(configDiff([], oneRepo, { repos: ['C:/one'] }), []);
    // 表記のゆらぎ（区切り・大文字小文字・末尾セパレータ）で誤報しない
    assert.deepEqual(configDiff([], oneRepo, { repos: ['c:\\one\\'] }), [],
        '表記が違うだけで「見えていない」と誤報している');

    // (3) 渡さなければ比べない（既存の呼び出し側を壊さない）
    assert.deepEqual(configDiff([], oneRepo), []);
    assert.deepEqual(configDiff([], oneRepo, {}), []);

    // (4) 2本見ているデーモンに1本だけ要求するのは差分ではない（多い方は問題にしない）
    assert.deepEqual(
        configDiff([], 'node v0/server.mjs --repo C:/one --repo C:/two', { repos: ['C:/one'] }),
        [],
    );
});

test('🚨 configDiff は空白入りのパスでも「見えている」と読める', () => {
    // 🚨 `--repo "C:/Users/a b/one"` を空白で切ると `"C:/Users/a` までしか取れず、
    //    **見えているのに毎回「入れ直してください」**になる（#31 と同じ罠）。
    const cmd = 'C:\\node.exe v0/server.mjs --repo "C:/Users/a b/one" --port 7749';
    assert.deepEqual(runningConfig(cmd).repos, ['C:/Users/a b/one']);
    assert.deepEqual(configDiff([], cmd, { repos: ['C:/Users/a b/one'] }), [],
        '空白入りのパスを取り違えている');
});

test('🚨 動いている実行デーモンの上限を必ず見せる（--status と同じ言い方で）', () => {
    // 上限が出ないと、`--timeout 3600` を打った人が 600 秒のデーモンに案内されたことに
    // 気付けない（「上限の話は1文字も出ない」が指摘の本体）
    assert.match(describeCaps(RUNNING_EXEC), /上限 3600秒/);
    assert.match(describeCaps('node v0/server.mjs --allow-exec --allow-write'),
        /上限 サーバ既定/, '既定であることを言っていない');
    // 実行が無効なら上限の話はしない（意味が無いので）
    assert.doesNotMatch(describeCaps('node v0/server.mjs --allow-write'), /上限/);
});

/* ===== --stop の対象（8回目のレビュー） =====
   🚨 `--stop` はマシン上の全デーモンを `taskkill /T /F` していたのに、
      止めた対象の repo を出さなかった。N 個のエージェントを並行で回す前提のツールで、
      repo A の作業を終えて --stop を打つと **repo B で 8 分走っている会話セッションが
      無言で消える**（/T なので claude -p の子孫まで死ぬ）。 */

const D = (pid, repo, extra = '') => ({
    pid, port: 7749 + pid, cmd: `node C:/x/v0/server.mjs --repo ${repo} ${extra}`,
});

test('🚨 --stop の既定はカレントのリポジトリだけ（他のリポジトリを道連れにしない）', () => {
    const list = [D(1, 'C:/a'), D(2, 'C:/b'), D(3, 'C:/A')];
    const r = stopTargets(list, 'C:/a');
    assert.deepEqual(r.targets.map(x => x.pid), [1, 3], '同じ repo（表記違いを含む）だけ止める');
    assert.deepEqual(r.others.map(x => x.pid), [2],
        '止めない相手を返していない（見せられないと「止めたのに動いている」になる）');
    // --all のときだけマシン上の全部
    assert.deepEqual(stopTargets(list, 'C:/a', true).targets.map(x => x.pid), [1, 2, 3]);
    assert.deepEqual(stopTargets(list, 'C:/a', true).others, []);
    // repo が分からない相手を「同じ repo」と読まない
    assert.deepEqual(stopTargets([{ pid: 9, cmd: 'node v0/server.mjs' }], 'C:/a').targets, []);
    assert.deepEqual(stopTargets(null, 'C:/a').targets, [], '壊れた入力で投げない');
});

/**
 * 🚨 **「別のリポジトリ」と「分からない」を分ける（#54）。**
 *
 * 以前は repo を読めなかった相手も `others` に入れて
 * **「← 別のリポジトリなので止めません」と断言**していた。実際は**分からない**だけで、
 * 止め残しに気付けない。「分からないなら分からないと言う」（#31）を、
 * 同じファイルの表示側が破っていた。
 */
test('🚨 --stop は repo を判定できない相手を「別のリポジトリ」と断言しない（#54）', () => {
    const list = [
        D(1, 'C:/a'),                                  // 同じ repo
        D(2, 'C:/b'),                                  // 別の repo（分かっている）
        { pid: 9, port: 1, cmd: 'node C:/x/v0/server.mjs' },        // --repo が無い
        { pid: 10, port: 2, cmd: 'node C:/x/v0/server.mjs --repo' }, // 値が欠けている
    ];
    const r = stopTargets(list, 'C:/a');
    assert.deepEqual(r.targets.map(x => x.pid), [1]);
    assert.deepEqual(r.others.map(x => x.pid), [2],
        '「別のリポジトリ」に判定できない相手が混ざっている（断言になる）');
    assert.deepEqual(r.unknown.map(x => x.pid), [9, 10],
        '判定できない相手を別枠で返していない');
    // --all なら全部止める（unknown も含む）。止めない枠は空
    const all = stopTargets(list, 'C:/a', true);
    assert.deepEqual(all.targets.map(x => x.pid), [1, 2, 9, 10]);
    assert.deepEqual(all.others, []);
    assert.deepEqual(all.unknown, []);
});

test('🚨 --stop は「調べられない」を「止まりました」と読まない', () => {
    const targets = [D(1, 'C:/a')];
    // 🚨 以前は `after.supported ? … : []` だったので、2回目の PowerShell が失敗すると
    //    left=[] → **何も言わず exit 0**（#31 と同型が同じ関数の中に残っていた）
    const unknown = stopOutcome({ after: { supported: false }, targets });
    assert.equal(unknown.exit, 1, '確認できていないのに成功にしている');
    assert.equal(unknown.unknown, true);

    const gone = stopOutcome({ after: { supported: true, list: [] }, targets });
    assert.deepEqual(gone, { exit: 0, unknown: false, left: [] });

    const left = stopOutcome({ after: { supported: true, list: [D(1, 'C:/a')] }, targets });
    assert.equal(left.exit, 1);
    assert.deepEqual(left.left, [1]);
    // taskkill が失敗していれば、消えて見えても成功にしない
    assert.equal(stopOutcome({ after: { supported: true, list: [] }, targets, failed: 1 }).exit, 1);
});

// ---- 起動口の配線（速い方。git も PowerShell も叩かない門）----

test('serve.mjs は --all を --stop 無しで受け付けない（配線）', async () => {
    // 🚨 SERVE_FLAGS に入れた瞬間に「知っているが何もしないフラグ」になるので、
    //    ここで止めないと `--all`（全部止めるつもり）が**起動**になる
    const r = await runScript('serve.mjs', ['--all', '--repo', NO_REPO]);
    assert.equal(r.code, 1, `止めていない: ${r.out}`);
    assert.match(r.out, /--all は --stop と一緒/, '門より先に別の検証で落ちている');
});

test('serve.mjs は --timeout が効かない組み合わせを黙って捨てない（配線）', async () => {
    // `--exec` が無いと上限はサーバに渡らない。**エラーにはしない**（自動起動の登録に
    // 残っていると「ログオン後だけ起動しない」になる）が、必ず言う
    const r = await runScript('serve.mjs', ['--timeout', '3600', '--repo', NO_REPO]);
    assert.match(r.out, /--timeout は --exec が無いと効きません/, '黙って捨てている');
    // 値の検証も「既に動いています」より前に通す（デーモンが動いていると
    // 以前は --timeout abc が一言も言われず exit 0 だった）
    const bad = await runScript('serve.mjs', ['--timeout', 'abc', '--repo', NO_REPO]);
    assert.equal(bad.code, 1, `止めていない: ${bad.out}`);
    assert.match(bad.out, /--timeout には 10〜86400/);
    assert.doesNotMatch(bad.out, /git リポジトリが見つかりません/,
        '値の検証が repo の解決より後ろにある（既に動いていると黙って通る形）');
});

test('serve.mjs は --stop の対象を決められなければ何も止めない（配線）', async () => {
    // 🚨 以前はカレントが git リポジトリでなくても**マシン上の全デーモンを止めた**。
    //    対象が決まらないなら何もしない（`--all` で明示させる）
    const r = await runScript('serve.mjs', ['--stop', '--repo', NO_REPO]);
    assert.equal(r.code, 1, `何かを止めようとした: ${r.out}`);
    assert.match(r.out, /git リポジトリの中ではありません/);
    assert.match(r.out, /--stop --all/, '全部止める方法を示していない');
});

/* ===== 実起動でしか測れない配線（8回目のレビュー） =====
   🚨 `--timeout` は純関数（`serverArgs` / `checkTimeout`）を全部テストしていたのに、
      **serve.mjs がそれを渡していることを誰も見ていなかった**。1行消しても 24 テスト
      全部緑で、変異も0件。落とすと `serve.mjs --exec --timeout 3600` が黙って
      600 秒で起動し、「回答が書かれる直前に SIGKILL」が復活する。
   ⚠️ 字面（`assert.match(src, /execTimeout/)`）では測らない。**実際に起動して、
      サーバが受け取った値を言わせる**（起動時に「上限 Ns」と出す）。 */

/** 空いている port を1つ借りる（借りて即返す。高い番号なので実用上ぶつからない） */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

function runGit(args, cwd) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
            (e, out) => (e ? reject(e) : resolve(String(out).trim())));
    });
}

/**
 * 一時リポジトリの名前で照合して、そのリポジトリを見ている node を全部拾う。
 *
 * 🚨 **`tag` が空だと `-like '**'` が全部の node.exe に当たる**（他のエージェントの
 *    検査サーバまで殺す）。呼ぶ前に必ず形を確かめる。
 * 🚨 **「調べられない」を「残っていない」と読まない**（残るとポートを塞ぐ）。
 */
function daemonsFor(tag) {
    assert.match(tag, /^kjp-wire-[a-z]+-[A-Za-z0-9]+$/, '掃除の照合に使う名前が一意でない');
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
        + `| Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { $_.ProcessId }`;
    return new Promise(resolve => {
        execFile('powershell', ['-NoProfile', '-Command', ps],
            { windowsHide: true, encoding: 'utf8' }, (e, out) => resolve(e
                ? { supported: false, pids: [] }
                : {
                    supported: true,
                    pids: String(out).split('\n').map(s => s.trim())
                        .filter(s => /^\d+$/.test(s)).map(Number),
                }));
    });
}

function taskkill(pid) {
    return new Promise(resolve => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, encoding: 'utf8' }, () => resolve());
    });
}

function portBusy(port) {
    return new Promise(resolve => {
        const s = createConnection({ host: '127.0.0.1', port });
        const done = v => { s.destroy(); resolve(v); };
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
        setTimeout(() => done(false), 1000);
    });
}

/**
 * 検証用に立てたものを**必ず**片付ける。残った文言を返す（null なら綺麗）。
 *
 * ⚠️ 掴んだ PID を殺すだけでは足りない。門を外す変異は**2本目のデーモンを立てる**ので、
 *    一時リポジトリの名前で照合して全部落とす（CLAUDE.md スクリプト規則6）。
 */
async function cleanup(tag, child, port) {
    if (process.platform === 'win32') {
        const found = await daemonsFor(tag);
        for (const pid of found.pids) await taskkill(pid);
        const left = await daemonsFor(tag);
        if (!found.supported || !left.supported) {
            return '検証用サーバを片付けられたか確認できませんでした（PowerShell が失敗）';
        }
        if (left.pids.length) return `検証用サーバが残りました: PID ${left.pids.join(', ')}`;
        return null;
    }
    if (child && child.exitCode === null) child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (child && child.exitCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
    }
    if (await portBusy(port)) return `検証用サーバが port ${port} を掴んだままです`;
    return null;
}

/**
 * 一時リポジトリ・一時 HOME で `serve.mjs` を実起動し、起動を待って body を呼ぶ。
 *
 * 🚨 **HOME の隔離は1箇所（`scratchHome`）で決める（#56）。**
 *    ここで別の一時 HOME を作ると「隔離を渡す場所」が2つになり、
 *    片方を外しても検査が落ちない = **守りが検証されない**状態になる
 *    （実際に、この形で変異が SURVIVED した）。
 *    `os.homedir()` は Windows では USERPROFILE、POSIX では HOME を見る。
 * ⚠️ **固定時間で待たない**（起動は git と PowerShell の探索を待つ。CLAUDE.md）。
 */
async function withDaemon(extra, body) {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-wire-repo-'));
    const tag = dir.split(/[\\/]/).pop();
    const env = {};
    let child = null;
    let port = 0;
    let err = null;
    try {
        await runGit(['init', '-q', '-b', 'main'], dir);
        const repo = await runGit(['rev-parse', '--show-toplevel'], dir);
        port = await freePort();
        child = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'),
            '--repo', dir, '--port', String(port), '--exec', ...extra], {
            cwd: ROOT, shell: false, windowsHide: true,
            env: childEnv(env),
        });
        let out = '';
        let exited = null;
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('error', e => { out += `\n[spawn 失敗] ${e.message}`; exited = -1; });
        child.on('close', c => { exited = c ?? 0; });
        // 🚨 **上限は「遅さを隠すため」ではなく、ハングを失敗として観測するため。**
        //    起動口は Windows で PowerShell の CIM 探索を待つので、CI では
        //    実測で 25s を超えることがある（`サーバが起動していない (exit=null)`
        //    = まだ生きているのに待ちが尽きた形で落ちた）。上限を広げ、
        //    **緑でも経過を出す**（遅くなっていく変化を、落ちる前に見えるようにする）。
        const startWaitMs = 60_000;
        const waitFrom = Date.now();
        const deadline = waitFrom + startWaitMs;
        while (!/上限 \d+s/.test(out) && exited === null && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
        }
        const startMs = Date.now() - waitFrom;
        assert.match(out, /上限 \d+s/,
            `サーバが起動していない (exit=${exited}, ${startMs}ms 待った／上限 ${startWaitMs}ms)`
            + `\n  出力: ${out.trim().slice(-400) || '(空)'}`);
        if (startMs > 10_000) {
            console.log(`  · 起動が遅い: ${startMs}ms（上限 ${startWaitMs}ms）`);
        }
        await body({ repo, dir, tag, env, port, out: () => out });
    } catch (e) { err = e; }
    const leak = await cleanup(tag, child, port);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err) {
        if (leak) err.message += `\n（さらに）${leak}`;
        throw err;
    }
    if (leak) throw new Error(leak);
}

test('🚨 serve.mjs の --timeout が実際にサーバに届く（実起動）', async () => {
    await withDaemon(['--timeout', '3600'], ({ out }) => {
        // サーバは起動時に受け取った上限を言う。600 なら渡っていない
        const m = /上限 (\d+)s/.exec(out());
        assert.equal(m?.[1], '3600',
            `サーバに --exec-timeout が届いていない（既定のまま起動した）:\n${out()}`);
    });
});

test('🚨 既に動いているデーモンとの差分で止まり、--stop が対象を見せる（実起動）', async () => {
    // `running()` は今のところ PowerShell 経由だけなので、差分の門も --stop も
    // Windows でしか通らない経路（**スキップしていることは告知される**）
    if (process.platform !== 'win32') return;
    await withDaemon(['--timeout', '3600'], async ({ dir, tag, env }) => {
        // (1) 上限とホストが違えば止める（以前は missing=[] で exit 0 = 黙って無効）
        const bad = await runScript('serve.mjs',
            ['--repo', dir, '--exec', '--timeout', '7200', '--allow-host', 'box-b.ts.net'], env);
        assert.equal(bad.code, 1, `黙って通した（要求が無効になる）:\n${bad.out}`);
        assert.match(bad.out, /--exec-timeout: 要求 7200 秒/, `上限の差分を出していない:\n${bad.out}`);
        assert.match(bad.out, /--allow-host: 要求 box-b\.ts\.net/, `ホストの差分を出していない:\n${bad.out}`);

        // (2) 🚨 **値の検証は「既に動いています」より前**。以前は門が後ろにあったので、
        //     デーモンが動いている間は壊れた値が**一言も言われないまま exit 0** だった
        const invalid = await runScript('serve.mjs',
            ['--repo', dir, '--exec', '--timeout', 'abc'], env);
        assert.equal(invalid.code, 1,
            `既に動いているときに値の検証が飛ばされている:\n${invalid.out}`);
        assert.match(invalid.out, /--timeout には 10〜86400/);

        // (3) 同じ設定なら今まで通り URL を案内して終わる（毎回止めさせる形にしない）
        const same = await runScript('serve.mjs', ['--repo', dir, '--exec', '--timeout', '3600'], env);
        assert.equal(same.code, 0, `同じ設定なのに止めた:\n${same.out}`);
        assert.match(same.out, /既に動いています/);
        assert.match(same.out, /上限 3600秒/, '動いているものの上限を出していない');

        // (4) `--stop` は止める前に repo と capability と巻き込む本数を見せる
        const stop = await runScript('serve.mjs', ['--stop', '--repo', dir], env);
        assert.match(stop.out, /これを止めます/, `止める対象を見せていない:\n${stop.out}`);
        assert.ok(stop.out.includes(tag),
            `止める対象の repo を出していない（他のリポジトリを道連れにしても気付けない）:\n${stop.out}`);
        assert.match(stop.out, /実行（任意コマンド）/, `止める対象の capability を出していない:\n${stop.out}`);
        assert.match(stop.out, /子孫 \d+ 個/, `巻き込む子プロセスの数を出していない:\n${stop.out}`);
        assert.equal(stop.code, 0, `止められなかった:\n${stop.out}`);
    });
});

/**
 * 🚨 **#54 の配線: 判定できない相手の言い方が実際に変わること。**
 *
 * 現実にこの状態になるのは「`node v0/server.mjs` を直に起動した」とき
 * （README が案内している素の起動）。コマンド行に `--repo` が無いので
 * `--stop` は repo を読めない。それを「別のリポジトリ」と断言すると、
 * **止め残しに気付けない。**
 *
 * ⚠️ Windows 以外では動いているものを調べる実装が無い（`running()` が
 *    `{supported:false}`）ので、この配線は測れない。skip はそう告知される（#52）。
 */
test('🚨 --stop は repo が読めない相手を「分からない」と出す（配線）', {
    skip: process.platform !== 'win32'
        ? `${process.platform} では動いているものを調べる実装が無い（running() が supported:false）`
        : false,
}, async () => {
    // ⚠️ 掃除の照合は `kjp-wire-…` の名前だけを許す（誤って他を掃かないため）。
    //    その規則に合わせて名前を付ける
    const dir = await mkdtemp(join(tmpdir(), 'kjp-wire-unknown-'));
    const other = await mkdtemp(join(tmpdir(), 'kjp-wire-scope-'));
    // ⚠️ Windows のパスは区切りが `\` なので、正規表現で分けると
    //    エスケープの取り扱いを間違えやすい（実際にここで全パスが tag になった）。
    //    `basename` を使う。
    const tag = basename(dir);
    let child = null;
    let err = null;
    try {
        await new Promise((res, rej) => {
            execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir }, e => (e ? rej(e) : res()));
        });
        await new Promise((res, rej) => {
            execFile('git', ['init', '-q', '-b', 'main'], { cwd: other }, e => (e ? rej(e) : res()));
        });
        const port = await freePort();
        // 🚨 **`--repo` を渡さずに直起動する**（cwd から読む素の使い方）。
        //    これで `--stop` から見て「repo が判定できない」相手ができる。
        child = spawn(process.execPath, [join(ROOT, 'v0', 'server.mjs'), '--port', String(port)],
            { cwd: dir, shell: false, windowsHide: true, env: childEnv() });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        const deadline = Date.now() + 30_000;
        while (!/http:\/\/127\.0\.0\.1:/.test(out) && child.exitCode === null && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.match(out, /http:\/\/127\.0\.0\.1:/, `直起動のサーバが立たない: ${out.slice(-300)}`);

        // 別のリポジトリを scope にして --stop（この相手は止まらない）
        const stop = await runScript('serve.mjs', ['--stop', '--repo', other]);
        assert.match(stop.out, /リポジトリが分からないので止めません/,
            `判定できない相手を「分からない」と出していない:\n${stop.out}`);
        // ⚠️ **断言していないこと**を測る（これが #54 の本体）。
        //    直起動の相手が「別のリポジトリ」の行に出ていたら断言になっている
        const lines = stop.out.split('\n').filter(l => l.includes(String(child.pid)));
        assert.ok(lines.length, `対象の PID ${child.pid} が出力に出ていない:\n${stop.out}`);
        for (const l of lines) {
            assert.equal(l.includes('別のリポジトリなので止めません'), false,
                `判定できないのに「別のリポジトリ」と断言している: ${l}`);
        }
        assert.match(stop.out, /--all/, '止める手段（--all）を案内していない');
    } catch (e) { err = e; }
    // 後始末（取り残しは仕組みで防ぐ）
    if (process.platform === 'win32') {
        const found = await daemonsFor(tag);
        for (const pid of found.pids) await taskkill(pid);
    }
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* noop */ } }
    await new Promise(r => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm(other, { recursive: true, force: true }).catch(() => {});
    if (err) throw err;
});

/* ===== #55: 黙って増える2本目と、動いたポートの告知（純関数） ===== */

test('🚨 他に動いているデーモンを告げる（黙って2本目にしない。#55）', () => {
    const list = [D(1, 'C:/a'), D(2, 'C:/b'), D(3, 'C:/A')];
    // 自分と同じ repo（表記違いも）は数えない
    const n = otherDaemonsNote({ supported: true, list }, 'C:/a');
    assert.equal(n.count, 1, `同じ repo を他人として数えている: ${JSON.stringify(n)}`);
    assert.match(n.lines[0], /PID 2/);
    assert.match(n.lines[0], /C:\/b/, '行に repo が入っていない（どれのことか分からない）');
    // 他に無ければ黙る
    assert.equal(otherDaemonsNote({ supported: true, list: [D(1, 'C:/a')] }, 'C:/a'), null);
    assert.equal(otherDaemonsNote({ supported: true, list: [] }, 'C:/a'), null);
    // 🚨 **「調べられない」を「0 本」と言わない**（running() と同じ型）。
    //    ⚠️ `list: []` だけで測ると、`supported` を見ない実装でも通ってしまう
    //    （最初そう書いて変異が SURVIVED した）。**中途半端な list が来ても
    //    黙る**ことを測る = 「supported を見ている」ことの検査になる。
    assert.equal(otherDaemonsNote({ supported: false, why: 'x' }, 'C:/a'), null,
        '調べられないのに「他に 0 本」と断言する形になっている');
    assert.equal(otherDaemonsNote({ supported: false, list: [D(2, 'C:/b')] }, 'C:/a'), null,
        'supported:false の list を信じている（調べられていない結果を数えている）');
});

/**
 * 🚨 **ポートが動いたら、トンネルの向き先も動いたことを言う（#55）。**
 *
 * `tailscale serve` は固定ポートを指しているので、空きに移ると
 * **母艦では正常・スマホからだけ繋がらない**（手元では絶対に気付けない）。
 */
test('🚨 --allow-host 付きでポートが動いたら向き先を告げる（#55）', () => {
    const lines = portShiftNote({ from: 7749, to: 7750, hosts: ['box.ts.net'] });
    assert.ok(lines.length >= 2, `告知が足りない: ${JSON.stringify(lines)}`);
    const all = lines.join('\n');
    assert.match(all, /スマホからは繋がりません/, '何が起きるかを言っていない');
    assert.match(all, /tailscale serve --bg 7750/, '直し方（新しいポート）を出していない');
    assert.match(all, /box\.ts\.net/, 'どの Host の話か分からない');
    // トンネルを使っていないなら黙る（関係ない警告で埋めない）
    assert.deepEqual(portShiftNote({ from: 7749, to: 7750, hosts: [] }), []);
    // 動いていないなら黙る
    assert.deepEqual(portShiftNote({ from: 7749, to: 7749, hosts: ['box.ts.net'] }), []);
    assert.deepEqual(portShiftNote({ from: NaN, to: 7750, hosts: ['box.ts.net'] }), []);
});

/**
 * 🚨 **読み取り専用のときに `token-read` を書き戻さない（10回目のレビュー / SERIOUS）。**
 *
 * その構成では `--token-file` が `token-read` そのものなので、
 * 派生値を書き戻すと**起動のたびに鍵が回る**（スマホのブックマークが毎回 401）。
 */
test('shouldWriteReadSecret: --token-file が token-read 自身なら書かない', () => {
    const read = 'C:/Users/me/.kjp-edit/token-read';
    assert.equal(shouldWriteReadSecret(read, read), false);
    // 区切り文字と大文字小文字の違いで「別ファイル」と誤判定しない（Windows）
    // ⚠️ バックスラッシュは書き換えの3段でエスケープが失われる（CLAUDE.md 規則8）ので
    //    リテラルに書かず組み立てる
    const bs = String.fromCharCode(92);
    assert.equal(shouldWriteReadSecret(read.split('/').join(bs), read), false);
    assert.equal(shouldWriteReadSecret('C:/USERS/ME/.kjp-edit/TOKEN-READ', read), false);
    // 実行・書き込みトークンなら書く（読み取りとして通るのは派生値だけなので必要）
    assert.equal(shouldWriteReadSecret('C:/Users/me/.kjp-edit/token-exec', read), true);
    assert.equal(shouldWriteReadSecret('C:/Users/me/.kjp-edit/token-write', read), true);
    assert.equal(shouldWriteReadSecret(null, read), false);
});
