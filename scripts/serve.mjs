#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 毎日使うための起動口。素の `node v0/server.mjs` で困っていたことを吸収する。
//
//   node scripts/serve.mjs                 # カレントのリポジトリを読み取り専用で
//   node scripts/serve.mjs --write         # checkout を有効に
//   node scripts/serve.mjs --exec          # 任意コマンドの実行も有効に（トークンは自動で永続化）
//   node scripts/serve.mjs --status        # 動いているものを一覧
//   node scripts/serve.mjs --stop          # 動いているものを止める
//
// 吸収していること:
//   1. **既に動いていたら二重起動しない。** 同じリポジトリを見ているなら URL を出して終わる
//      （素のサーバは EADDRINUSE で落ちるだけだった）
//   2. **リポジトリを自動で見つける。** サブディレクトリからでも動く
//   3. **ポートが埋まっていたら空きを探す。** ただし黙って変えず、必ず出す
//   4. **トークンを永続化する。** 遠隔から使うたびに貼り直さない
//      （置き場所は ~/.kjp-edit/。**リポジトリの中には置かない**）
//
// ⚠️ `.ps1` / `.bat` は作らない（CLAUDE.md）。ここも .mjs のみ。

import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
// 🚨 Windows のコマンドラインを作る／読む規則は共有モジュールに集約している
//    （純粋な関数なのでユニットテストで固定できる。scripts/winargs.test.mjs）
import { repoOf, samePathish } from './winargs.mjs';
// 🚨 argv の組み立てと門は純関数に切り出してテストで固定している
//    （scripts/serveargs.test.mjs。#45 まではここに検査が1件も無かった）
import {
    SERVE_FLAGS, unknownFlag, checkPort, checkTimeout, collectHosts, serverArgs,
    runningCaps, requestedCaps, describeCaps,
} from './serveargs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'v0', 'server.mjs');
const STATE_DIR = join(homedir(), '.kjp-edit');
const DEFAULT_PORT = 7749;

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

if (has('--help') || has('-h')) {
    console.log(`使い方:
  node scripts/serve.mjs [--repo <path>] [--port ${DEFAULT_PORT}]
                         [--write] [--exec] [--allow-host <name>]
  node scripts/serve.mjs --status | --stop

  --write        checkout を有効にする
  --exec         任意コマンドの実行も有効にする（🚨 遠隔コード実行になる）
  --allow-host   トンネル経由のホスト名を許可する（既定はループバックのみ）
  --watch        エージェントの活動を観測する（リポジトリ外の記録を読む）
  --agents-text  発話とコマンド行も出す（--watch を含む。トンネル越しに読まれます）

  状態は ${STATE_DIR} に置く（トークン・実行の監査ログ）。`);
    process.exit(0);
}

/** git を1回だけ呼ぶ小さなヘルパ（本体は v0/git.mjs。ここは起動前なので単独で持つ） */
function git(args, cwd) {
    return new Promise((res, rej) => {
        execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8' },
            (e, out) => (e ? rej(e) : res(out.trim())));
    });
}

/** その port で listen しているものがあるか */
function inUse(port) {
    return new Promise(res => {
        const s = createConnection({ host: '127.0.0.1', port });
        const done = v => { s.destroy(); res(v); };
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
        setTimeout(() => done(false), 1200);
    });
}

/**
 * 🚨 **知らないフラグを黙って捨てない。**
 *
 * 以前は未知のオプションを無視していたので、`--allow-write` を渡した人に
 * **「読み取り専用（書き込みは --allow-write で有効化）」と表示**していた。
 * 打ったフラグが効いていないことが分からないのは、capability を明示させる
 * 設計（意識的な操作にする）の根拠そのものを壊す（#30）。
 * サーバ側の名前で打たれることが多いので、正しい名前を示して止める。
 */
{
    const bad = unknownFlag(argv, SERVE_FLAGS, 'この起動口');
    if (bad) {
        console.error(`\n✖ 知らないオプションです: ${bad.flag}${bad.hint}`);
        console.error(`  使えるもの: ${bad.known.join(' ')}`);
        console.error('  サーバに直接渡したいなら node v0/server.mjs を使ってください\n');
        process.exit(1);
    }
}

/**
 * 動いている kjp-edit を探す。
 *
 * 🚨 **「調べられない」を「無い」と言わない。** 以前は Windows 以外で `[]` を返して
 *    いたので、`--status` は起動中でも「動いている kjp-edit はありません」と**断言**し、
 *    `--stop` は何も止めずに同じ文言を出して exit 0 していた。
 *    同じファイルの下で自分が「分からないなら分からないと言う」（#31）と書いている
 *    その規則を、ここが最も破っていた（6回目のレビュー）。
 *    さらに二重起動の門（`already`）も常に false になるので、同じリポジトリに
 *    2本目が黙って立ち上がり、watcher・キャッシュ・実行枠・監査が二重になっていた。
 * @returns {Promise<{supported: boolean, list: object[], why?: string}>}
 */
async function running() {
    if (process.platform !== 'win32') {
        return {
            supported: false,
            list: [],
            why: `${process.platform} では動いているものを調べる実装がありません`
                + '（今は PowerShell 経由のみ）',
        };
    }
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
        + '| Where-Object { $_.CommandLine -like \'*v0/server.mjs*\' -or $_.CommandLine -like \'*v0\\server.mjs*\' } '
        + '| ForEach-Object { $p=(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue '
        + '| Where-Object OwningProcess -eq $_.ProcessId | Select-Object -First 1).LocalPort; '
        + '"$($_.ProcessId)`t$p`t$($_.CommandLine)" }';
    return new Promise(res => {
        execFile('powershell', ['-NoProfile', '-Command', ps],
            { windowsHide: true, encoding: 'utf8' }, (e, out) => {
                // ⚠️ PowerShell が失敗したのも「無い」ではない
                if (e) { res({ supported: false, list: [], why: `PowerShell が失敗: ${e.message}` }); return; }
                res({
                    supported: true,
                    list: out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
                        const [pid, port, ...rest] = l.split('\t');
                        return { pid: Number(pid), port: Number(port) || null, cmd: rest.join('\t') };
                    }),
                });
            });
    });
}

if (has('--status')) {
    const { supported, list, why } = await running();
    if (!supported) {
        console.log(`⚠ 調べられませんでした: ${why}`);
        console.log('  「動いていない」ではなく「分からない」です。手で確認してください:');
        console.log(`      lsof -nP -iTCP:${DEFAULT_PORT} -sTCP:LISTEN`);
        console.log('      ps -ef | grep v0/server.mjs');
        process.exit(1);
    }
    if (!list.length) { console.log('動いている kjp-edit はありません'); process.exit(0); }
    for (const r of list) {
        const repo = repoOf(r.cmd) ?? '(cwd)';
        const caps = [r.cmd.includes('--allow-exec') && '実行', r.cmd.includes('--allow-write') && '書き込み']
            .filter(Boolean).join('+') || '読み取り専用';
        // 何が有効かを全部出す（観測フラグを落としていたのが #30）
        const watch = r.cmd.includes('--allow-transcript-text') ? ' 活動観測+発話'
            : r.cmd.includes('--watch-agents') ? ' 活動観測' : '';
        // 🚨 **`--allow-host` を必ず出す。** ここは「何が有効か」を確認する唯一の手段で、
        //    Host 許可は**誰が届くか**を決める唯一のフラグ。これが無いと
        //    tailnet 全体から読めるデーモンとループバック専用が同じ1行に見える。
        //    `autostart.mjs` の status は出しているので、片方だけ欠けた非対称だった。
        //    ⚠️ 1件だけ出して省略しない（複数指定できる）。
        const hosts = [...r.cmd.matchAll(/--allow-host\s+(\S+)/g)].map(m => m[1]);
        const hostPart = hosts.length ? `  Host許可: ${hosts.join(', ')}` : '  ループバックのみ';
        console.log(`PID ${r.pid}  port ${r.port ?? '?'}  ${caps}${watch}${hostPart}  ${repo}`);
    }
    process.exit(0);
}

if (has('--stop')) {
    const { supported, list, why } = await running();
    if (!supported) {
        console.log(`⚠ 何を止めればよいか分かりませんでした: ${why}`);
        console.log('  何も止めていません。手で止めてください:');
        console.log('      pkill -f v0/server.mjs   # 木ごと止めるなら pkill -f -g <pgid>');
        process.exit(1);
    }
    if (!list.length) { console.log('動いている kjp-edit はありません'); process.exit(0); }
    // 🚨 **`process.kill(pid)` では孫が残る。** Windows の `process.kill` は
    //    TerminateProcess 相当なので、対象の `process.on('SIGTERM')` が**走らない**。
    //    そのハンドラが `killTree()`（`taskkill /T /F`）を呼ぶ唯一の場所なので、
    //    `--stop` 経路ではプロセス木が一切掃除されず、**exec が立てた孫
    //    （`cmd /c npm test` の中身、`claude -p` の子）が残る**。
    //    `server.mjs` に「Windows の child.kill() は TerminateProcess 相当で
    //    その1プロセスしか殺さない」と自分で書いてあるのに、停止経路がそれを迂回していた。
    //    「停止しました」と書く前に本当に停止したかを確かめる（6回目のレビュー）。
    let failed = 0;
    for (const r of list) {
        const killed = await new Promise(res => {
            execFile('taskkill', ['/PID', String(r.pid), '/T', '/F'],
                { windowsHide: true, encoding: 'utf8' }, e => res(!e));
        });
        if (killed) console.log(`停止: PID ${r.pid} (port ${r.port ?? '?'}) — 子プロセスも含めて`);
        else {
            failed++;
            console.log(`⚠ 停止できませんでした: PID ${r.pid}`
                + '（まだ走っている可能性があります。taskkill /PID <pid> /T /F を手で試してください）');
        }
    }
    // 本当に消えたかを確かめてから終わる（「止めたつもり」を作らない）
    const after = await running();
    const left = after.supported ? after.list.filter(r => list.some(x => x.pid === r.pid)) : [];
    if (left.length) {
        console.log(`⚠ まだ動いています: ${left.map(r => `PID ${r.pid}`).join(', ')}`);
        process.exit(1);
    }
    process.exit(failed ? 1 : 0);
}

// ---- リポジトリを見つける ----
let repo = val('--repo', process.cwd());
try {
    repo = await git(['rev-parse', '--show-toplevel'], repo);
} catch {
    console.error(`\n✖ git リポジトリが見つかりません: ${repo}`);
    console.error('  --repo でパスを指定してください\n');
    process.exit(1);
}

// ---- 既に動いていないか ----
const probe = await running();
// 🚨 **二重起動の門が効かないことを黙って通さない。** 調べられない環境では
//    `already` が常に false になり、同じリポジトリに2本目が立ち上がって
//    watcher・キャッシュ・実行枠・監査が二重になる（6回目のレビュー）。
if (!probe.supported) {
    console.log(`⚠ 既に動いていないかを確認できません: ${probe.why}`);
    console.log('  二重起動の門が効きません。同じリポジトリを2本見ると'
        + 'watcher・キャッシュ・実行枠・監査が二重になります。');
}
const already = probe.list.find(r => samePathish(repoOf(r.cmd), repo));
if (already) {
    console.log(`既に動いています → http://127.0.0.1:${already.port ?? '?'}`);
    console.log(`  PID ${already.pid}  repo ${repo}`);
    // 🚨 **動いているものの capability を必ず出す。** 以前は URL だけを出していたので、
    //    先に `--exec` のデーモンが動いていると、素の `node scripts/serve.mjs`
    //    （読み取り専用のつもり）が「既に動いています → URL」と出して exit 0 し、
    //    **案内した先が RCE 可能なデーモンであることを1文字も言わなかった**。
    console.log(`  動いているもの: ${describeCaps(already.cmd)}`);
    // 🚨 **打ったフラグを黙って捨てない**（#30 と同じ根拠）。今回要求した capability が
    //    動いているものに無いなら、exit 0 にせず**差分を並べて**止めて入れ直させる。
    const missing = requestedCaps(argv).filter(c => !runningCaps(already.cmd).includes(c));
    if (missing.length) {
        console.error(`
✖ 要求した capability が動いているものに含まれていません: ${missing.join(', ')}`);
        console.error('  黙って無視すると「打ったのに効かない」状態になります。');
        console.error('  入れ直してください:');
        console.error('      node scripts/serve.mjs --stop');
        // ⚠️ 打った引数をそのまま見せる（スクリプトの絶対パスは出さない。読みにくいだけ）
        const shown = argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
        console.error(`      node scripts/serve.mjs ${shown}\n`);
        process.exit(1);
    }
    console.log('  止めるには: node scripts/serve.mjs --stop');
    process.exit(0);
}

// ---- ポートを決める（黙って変えない） ----
const portCheck = checkPort(val('--port', undefined), DEFAULT_PORT);
if (portCheck.error !== undefined) {
    console.error(`\n✖ --port には 1〜65535 を指定してください（受け取った値: ${portCheck.error}）\n`);
    process.exit(1);
}
let port = portCheck.port;

// ---- 実行セッションの絶対上限（既定 600 秒はエージェントの仕事に足りない） ----
const timeoutCheck = checkTimeout(val('--timeout', undefined));
if (timeoutCheck.error !== undefined) {
    console.error(`\n✖ --timeout には 10〜86400（秒）を指定してください`
        + `（受け取った値: ${timeoutCheck.error}）`);
    console.error('  上限そのものは外せません（取り残しの唯一の歯止めなので）。\n');
    process.exit(1);
}
if (await inUse(port)) {
    let found = null;
    for (let p = port + 1; p <= port + 20; p++) {
        if (!(await inUse(p))) { found = p; break; }
    }
    if (!found) {
        console.error(`\n✖ ${port} から 20 個先まで空きがありません\n`);
        process.exit(1);
    }
    // ⚠️ **「別のプロセス」と断定しない。** 掴んでいるのが同じリポジトリを見る
    //    自分自身のこともある（二重起動の判定が外れていた頃はまさにそれで、
    //    「別のプロセス」という説明が事実と違っていた。#31）。
    //    分かる範囲で正体を出し、分からないなら分からないと言う。
    const holder = (await running()).list.find(r => r.port === port);
    const who = holder
        ? `PID ${holder.pid} の kjp-edit（repo ${repoOf(holder.cmd) ?? '不明'}）`
        : '別のプロセス（正体は分かりません）';
    console.log(`⚠ ポート ${port} は使用中です — ${who}。${found} を使います。`);
    if (holder) {
        console.log('  同じリポジトリを見ているなら2本目は不要です'
            + '（watcher・キャッシュ・実行枠が二重になります）。');
        console.log('  止めるには: node scripts/serve.mjs --stop');
    }
    port = found;
}

// ---- capability とトークン ----
await mkdir(STATE_DIR, { recursive: true });

// 🚨 **古い共用トークンを「読み取り専用」に降格させる（実行には引き継がない）。**
//    以前は `~/.kjp-edit/token` を読み取りトンネルと実行の両方に渡していた。
//    そのままファイル名を変えると、スマホのブックマークが黙って 401 になる。
//    そこで古い値を `token-read` に引き継ぎ、**実行用は新しい値にする**
//    （= 漏れているかもしれない古い値では実行できない）。
{
    const old = join(STATE_DIR, 'token');
    const read = join(STATE_DIR, 'token-read');
    if (existsSync(old) && !existsSync(read)) {
        try {
            await writeFile(read, await readFile(old, 'utf8'), { encoding: 'utf8', mode: 0o600 });
            console.log('ℹ 読み取り用トークンを token-read に引き継ぎました'
                + '（実行用は token-exec に分けました。古い値では実行できません）。');
            console.log(`  古いファイルは使われません。消して構いません: ${old}`);
        } catch (e) {
            console.error(`⚠ 古いトークンを引き継げませんでした: ${e.message}`);
            console.error('  読み取り用の URL は新しくなります（開き直してください）。');
        }
    }
}

// 🔒 ホスト名は**自動起動と同じ検証**を通す。片方だけ無検証という非対称が #29 の形。
const hostCheck = collectHosts(argv);
if (hostCheck.error !== undefined) {
    console.error('\n✖ --allow-host にはホスト名を指定してください'
        + `（受け取った値: ${hostCheck.error ?? '(無し)'}）\n`);
    process.exit(1);
}
// 🔒 capability の分界（--exec ⊃ --write、観測は独立）と、トークンの永続化、
//    引き継ぎは serveargs.mjs の純関数に集約している（テストで固定）。
const args = serverArgs({
    argv, server: SERVER, repo, port,
    // 🚨 **読み取り用と実行用を同じ値にしない**（6回目のレビュー）。
    //    読み取り用の URL をスマホで開くことが、実行トークンを配ることになっていた。
    tokenFile: join(STATE_DIR, 'token-read'),
    // 🚨 write も別の値にする（読み取り用として配ったトークンで checkout させない）
    writeTokenFile: join(STATE_DIR, 'token-write'),
    execTokenFile: join(STATE_DIR, 'token-exec'),
    auditLog: join(STATE_DIR, 'exec-audit.jsonl'),
    execTimeout: timeoutCheck.seconds,
});
const wantExec = has('--exec');
const wantWrite = wantExec || has('--write');

// ---- 起動 ----
const child = spawn(process.execPath, args, {
    cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit',
});
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { child.kill(); } catch { /* noop */ } });
}
// 状態を書き残す（--status が PowerShell に頼らずに済む足がかり。今は参考情報）
await writeFile(join(STATE_DIR, 'last.json'),
    `${JSON.stringify({ repo, port, exec: wantExec, write: wantWrite, pid: child.pid }, null, 1)}\n`,
    'utf8');
void dirname;
