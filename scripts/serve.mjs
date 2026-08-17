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
import { repoOf, samePathish, parseProcPairs, descendantsOf } from './winargs.mjs';
import { readSecretOf } from '../v0/readsecret.mjs';
// 🚨 argv の組み立てと門は純関数に切り出してテストで固定している
//    （scripts/serveargs.test.mjs。#45 まではここに検査が1件も無かった）
import {
    SERVE_FLAGS, unknownFlag, checkPort, timeoutFrom, collectHosts, collectRepos, serverArgs,
    configDiff, describeCaps, stopTargets, stopOutcome,
    otherDaemonsNote, portShiftNote, shouldWriteReadSecret, servesRepo,
    portFrom, stopRepoFrom,
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
  node scripts/serve.mjs [--repo <path>]... [--port ${DEFAULT_PORT}] [--timeout <秒>]
                         [--write] [--exec] [--allow-host <name>]
  node scripts/serve.mjs --status | --stop [--all]

  --repo         複数指定できる（1本目が既定。読める範囲はここで固定される）
  --write        checkout を有効にする
  --exec         任意コマンドの実行も有効にする（🚨 遠隔コード実行になる）
  --timeout      実行の絶対上限（秒。既定 600。--exec と一緒に使う）
  --allow-host   トンネル経由のホスト名を許可する（既定はループバックのみ）
  --watch        エージェントの活動を観測する（リポジトリ外の記録を読む）
  --agents-text  発話とコマンド行も出す（--watch を含む。トンネル越しに読まれます）
  --stop         **カレントのリポジトリの**デーモンを止める（子プロセスも一緒に落ちます）
  --all          --stop に付けると、マシン上の全デーモンを止める
                 （他のリポジトリで走っているセッションも道連れになります）

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

// 🚨 **`--all` は `--stop` の修飾。単独で打たれたら黙って捨てない。**
//    SERVE_FLAGS に入れた瞬間に「知っているが何もしないフラグ」になるので、
//    ここで止めないと `serve.mjs --all`（全部止めるつもり）が**起動**になる。
if (has('--all') && !has('--stop')) {
    console.error('\n✖ --all は --stop と一緒にしか使えません（単独では何もしません）');
    console.error('      node scripts/serve.mjs --stop        # このリポジトリのものだけ');
    console.error('      node scripts/serve.mjs --stop --all  # マシン上の全部\n');
    process.exit(1);
}

// ---- 打った値を先に検証する（黙って既定に落とさない） ----
// 🚨 **「既に動いています」より前に検証する。** 以前は port / timeout / host の検証が
//    二重起動の門の**後ろ**にあったので、デーモンが動いている間は
//    `--timeout abc` も `--port 99999` も**一言も言われないまま exit 0** していた
//    （打った値が捨てられたことが分からない = #30 と同じ形。8回目のレビュー）。
//    門はフォールバックより前に置く。
// ⚠️ 値の欠落も error にする（`serve.mjs --port` が黙って既定で起動していた）
const portCheck = portFrom(argv, DEFAULT_PORT);
if (portCheck.error !== undefined) {
    console.error(`\n✖ --port には 1〜65535 を指定してください（受け取った値: ${portCheck.error}）\n`);
    process.exit(1);
}
// ---- 実行セッションの絶対上限（既定 600 秒はエージェントの仕事に足りない） ----
const timeoutCheck = timeoutFrom(argv);
if (timeoutCheck.error !== undefined) {
    console.error(`\n✖ --timeout には 10〜86400（秒）を指定してください`
        + `（受け取った値: ${timeoutCheck.error}）`);
    console.error('  上限そのものは外せません（取り残しの唯一の歯止めなので）。\n');
    process.exit(1);
}
// ⚠️ `--timeout` は実行の上限なので `--exec` が無ければサーバに渡らない。
//    **エラーにはしない**（自動起動の登録に残っていると「ログオン後だけ起動しない」に
//    なる）が、黙って捨てもしない。
if (timeoutCheck.seconds !== null && !has('--exec')) {
    console.log('⚠ --timeout は --exec が無いと効きません'
        + '（実行が無効なので実行の上限もありません）。');
}
// 🔒 ホスト名は**自動起動と同じ検証**を通す。片方だけ無検証という非対称が #29 の形。
const hostCheck = collectHosts(argv);
if (hostCheck.error !== undefined) {
    console.error('\n✖ --allow-host にはホスト名を指定してください'
        + `（受け取った値: ${hostCheck.error ?? '(無し)'}）\n`);
    process.exit(1);
}

/** そのディレクトリを含むリポジトリのルート。見つからなければ null */
async function topLevel(where) {
    try { return await git(['rev-parse', '--show-toplevel'], where); } catch { return null; }
}

/**
 * 対象の pid の**子孫の数**を数える（`taskkill /T` で一緒に落ちるもの）。
 *
 * 🚨 **「調べられない」を 0 と言わない**（`running()` と同じ型にする）。
 *    0 と言うと「巻き込むものは無い」という**断言**になる。
 */
async function descendantCounts(pids) {
    if (process.platform !== 'win32') {
        return { supported: false, counts: new Map(), why: `${process.platform} では実装がありません` };
    }
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object '
        + '{ "$($_.ProcessId)`t$($_.ParentProcessId)" }';
    const out = await new Promise(res => {
        execFile('powershell', ['-NoProfile', '-Command', ps],
            { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
            (e, stdout) => res(e ? null : stdout));
    });
    if (out === null) return { supported: false, counts: new Map(), why: 'PowerShell が失敗しました' };
    const pairs = parseProcPairs(out);
    const counts = new Map();
    for (const pid of pids) counts.set(pid, descendantsOf(pairs, pid).length);
    return { supported: true, counts };
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

/* ---------------------------------------------------------------------------
 * 🔑 端末の承認（`docs/device-approval.md`）
 *
 * 🚨 **ここが「母艦にいること」の証明。** 合言葉はデーモンの stdout と
 *    `~/.kjp-edit/pair-code`（0600）にだけ出る。読めるのはこのマシンの所有者だけ。
 *    ⚠️ 窓なしで起動していると stdout が見えないので、**このコマンドが実質の入口**。
 * --------------------------------------------------------------------------- */
if (has('--pair')) {
    const codePath = join(STATE_DIR, 'pair-code');
    const target = has('--revoke') ? val('--revoke', null) : null;
    if (has('--revoke') && !target) {
        console.error('\n✖ --revoke には端末の id を指定してください');
        console.error('      node scripts/serve.mjs --pair            # 一覧と id を見る');
        console.error('      node scripts/serve.mjs --pair --revoke <id>\n');
        process.exit(1);
    }

    // 動いているデーモンに聞く（在庫の値は古いことがあるので、動いていれば HTTP を優先）
    const probe = await running();
    const scope = await topLevel(process.cwd());
    const mine = probe.supported
        ? probe.list.find(r => servesRepo(r.cmd, scope) === true) : null;
    let token = null;
    try { token = (await readFile(join(STATE_DIR, 'token-exec'), 'utf8')).trim(); } catch { /* 無い */ }

    // 🚨 **「動いていない」と「動いているが管理トークンが無い」を分ける（11回目のレビュー）。**
    //    以前はどちらも askDaemon が null になり、`--write` デーモンに対して
    //    **現に走っているのに「デーモンが動いていない」と嘘表示**していた
    //    （`--stop` の「停止しました」嘘と同型）。端末の登録は --allow-exec のデーモンで
    //    だけ使えるので、token-exec が無い = そのデーモンでは pairing が無効、と告げる。
    const cantAsk = !mine?.port ? 'down' : !token ? 'no-token' : null;
    const cantAskWhy = cantAsk === 'down'
        ? 'このリポジトリを配信しているデーモンが動いていません'
        : 'デーモンは動いていますが、管理トークン（~/.kjp-edit/token-exec）がありません'
            + '（端末の登録・失効は --allow-exec のデーモンでだけ使えます）';

    const askDaemon = async (path, body) => {
        if (cantAsk) return null;
        try {
            const r = await fetch(`http://127.0.0.1:${mine.port}/api/v0/pair/${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-kjp-token': token,
                    'sec-fetch-site': 'same-origin',
                },
                body: JSON.stringify(body ?? {}),
            });
            const text = await r.text();
            try { return { code: r.status, body: JSON.parse(text) }; }
            catch { return { code: r.status, body: text.slice(0, 200) }; }
        } catch (e) { return { code: 0, body: e.message }; }
    };

    if (target) {
        const r = await askDaemon('revoke', { id: target });
        if (r === null) {
            // ⚠️ 稼働状態と権限不足を区別して告げる（「分からない」と「無い」を分ける）
            console.error(`\n✖ 失効できません: ${cantAskWhy}`);
            console.error('   （台帳を直接書き換えると、動いているデーモンの記憶と食い違います）\n');
            process.exit(1);
        }
        if (r.code !== 200) {
            console.error(`\n✖ 失効できませんでした: ${r.body?.error ?? r.body}\n`);
            process.exit(1);
        }
        console.log(`失効しました: ${r.body.device?.label ?? target}`);
        // 🔒 **回転したことを必ず告げる。** 生トークンを貼ったタブと読み取り Cookie が
        //    無効になるので、黙っていると「急に入れなくなった」になる（原因が分からない失敗）。
        if (r.body.tokenRotated) {
            console.log('');
            console.log('🔑 実行トークンを回転しました（失効を本物にするため）。');
            console.log('   理由: 承認した端末は実行を通す = `cat token-exec` で生トークンを'
                + '写せるので、台帳から外すだけでは写しが生き続けます。');
            console.log('   ⚠️ 生トークンを貼っていたタブと読み取り Cookie は無効になりました'
                + '（?token= 付き URL を開き直してください）。');
            console.log('   ✅ 他の承認済み端末はそのまま使えます（端末の鍵は生トークンと独立）。');
            console.log(`   新しい値: ${join(STATE_DIR, 'token-exec')}`);
        }
        process.exit(0);
    }

    // 🚨 **先にデーモンへ聞く（レビュー11・指摘D）。** これで期限切れの合言葉ファイルが
    //    サーバ側で掃かれる（/pair ハンドラ入口の sweep）。**その後で**ファイルを読むので、
    //    死んだ合言葉を「まだ使える」と出す嘘が起きない。順序が守りの本体。
    const listed = await askDaemon('list', {});
    const pend = listed?.code === 200 ? listed.body.pending : null;

    // 合言葉（承認待ちがあるときだけ存在する）
    let code = null;
    try { code = (await readFile(codePath, 'utf8')).trim(); } catch { /* 無い */ }

    console.log('');
    // 🔒 **合言葉の生死はデーモンの pending が真実。** デーモンに聞けているのに pending が
    //    無いなら、ファイルに値が残っていても**それは死んでいる**ので出さない。
    //    デーモンに聞けないときだけ、ファイルの値を「生死は確かめられない」と断って出す。
    const showCode = code && (pend || listed === null);
    if (showCode) {
        console.log(`🔑 合言葉: ${code}`);
        if (pend) {
            console.log('   この値を**登録したい端末**に入力してください。'
                + `（あと ${Math.round((pend.expiresInMs ?? 0) / 1000)} 秒 / `
                + `残り試行 ${pend.triesLeft} / 端末: ${pend.label}）`);
        } else {
            // listed === null: デーモンに聞けなかった（稼働状態と権限は下で告げる）
            console.log('   ⚠ デーモンに聞けないので、この合言葉が**まだ生きているかは確かめられません**'
                + '（期限切れかもしれません）。');
        }
    } else if (code && !pend) {
        // ファイルに値はあるがデーモンは pending 無しと答えた = 期限切れ（サーバが掃いた後）
        console.log('承認待ちの要求はありません（前の合言葉は期限切れです）。');
        console.log('   端末側で「この端末を登録」を押すと、ここに新しい合言葉が出ます。');
    } else {
        console.log('承認待ちの要求はありません。');
        console.log('   端末側で「この端末を登録」を押すと、ここに合言葉が出ます。');
    }

    console.log('');
    if (listed === null) {
        // ⚠️ **「調べられない」を「無い」と言わない。** 台帳のファイルを読んで代わりに出すが、
        //    最終使用時刻は初回しか保存していないので**古いことがある**と告げる。
        //    稼働状態と権限不足を取り違えない（cantAskWhy が事実を分けている）。
        console.log(`⚠ デーモンに聞けないので台帳のファイルから読みます: ${cantAskWhy}`);
        console.log('  （最終使用は初回のぶんだけなので古いことがあります）');
        try {
            const raw = JSON.parse(await readFile(join(STATE_DIR, 'devices.json'), 'utf8'));
            const list = (raw.devices ?? []).map(d => ({
                id: d.id, label: d.label, createdAt: d.createdAt,
                lastUsedAt: d.lastUsedAt, revokedAt: d.revokedAt,
            }));
            printDevices(list);
        } catch { console.log('  台帳はまだありません（承認した端末が0台）'); }
    } else if (listed.code !== 200) {
        console.log(`⚠ 一覧を取れませんでした: ${listed.body?.error ?? listed.body}`);
    } else {
        printDevices(listed.body.devices ?? []);
    }
    console.log('');
    console.log('  失効: node scripts/serve.mjs --pair --revoke <id>');
    console.log('');
    process.exit(0);
}

function printDevices(list) {
    const live = list.filter(d => !d.revokedAt);
    const dead = list.filter(d => d.revokedAt);
    if (!live.length) console.log('承認した端末: 0 台');
    else {
        console.log(`承認した端末: ${live.length} 台`);
        for (const d of live) {
            console.log(`  ${d.id.slice(0, 8)}  ${d.label}`
                + `  登録 ${String(d.createdAt).slice(0, 16).replace('T', ' ')}`
                + `  最終使用 ${d.lastUsedAt ? String(d.lastUsedAt).slice(0, 16).replace('T', ' ') : '(まだ)'}`);
        }
    }
    // ⚠️ 失効したものも出す（消したつもりが残っていないかを確かめられるように）
    if (dead.length) {
        console.log(`失効済み: ${dead.length} 台`);
        for (const d of dead) console.log(`  ${d.id.slice(0, 8)}  ${d.label}  失効 ${String(d.revokedAt).slice(0, 16).replace('T', ' ')}`);
    }
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
    // 🚨 **何が有効かを全部出す。** 観測フラグを落としていたのが #30、`--allow-host`
    //    （**誰が届くか**を決める唯一のフラグ）を落としていたのが 7回目のレビュー、
    //    実行の絶対上限（**投げた仕事が完走するか**）を落としていたのが 8回目のレビュー。
    //    ⚠️ **「既に動いています」と同じ関数で言う。** 以前はここだけ自前で組み立てて
    //       いたので、片方に足した情報がもう片方から抜けるという非対称が繰り返し起きた。
    for (const r of list) {
        console.log(`PID ${r.pid}  port ${r.port ?? '?'}  ${describeCaps(r.cmd)}`
            + `  ${repoOf(r.cmd) ?? '(cwd)'}`);
    }
    process.exit(0);
}

if (has('--stop')) {
    // 🚨 **既定はカレントのリポジトリだけを止める**（8回目のレビュー）。
    //    N 個のエージェントを並行で回す前提のツールなので、repo A の作業を終えて
    //    `--stop` を打つと **repo B で走っている会話セッションが無言で消えていた**
    //    （`taskkill /T` なので `claude -p` の子孫まで落ちる）。
    const wantAll = has('--all');
    let scope = null;
    if (!wantAll) {
        // 🚨 **値が無い `--repo` をカレントに落とさない。**
        //    落とすと**意図と違うデーモンを `taskkill /T /F`** する（子ごと死ぬ）。
        const want = stopRepoFrom(argv);
        if (want.error !== undefined) {
            console.error('\n✖ --repo にパスを指定してください'
                + `（受け取った値: ${want.error}）\n`);
            process.exit(1);
        }
        scope = await topLevel(want.repo ?? process.cwd());
        if (!scope) {
            console.error('\n✖ git リポジトリの中ではありません（どのデーモンを止めるか決められません）');
            console.error('  リポジトリを指定するか、マシン上の全部を止めると明示してください:');
            console.error('      node scripts/serve.mjs --stop --repo <path>');
            console.error('      node scripts/serve.mjs --stop --all\n');
            process.exit(1);
        }
    }
    const { supported, list, why } = await running();
    if (!supported) {
        console.log(`⚠ 何を止めればよいか分かりませんでした: ${why}`);
        console.log('  何も止めていません。手で止めてください:');
        console.log('      pkill -f v0/server.mjs   # 木ごと止めるなら pkill -f -g <pgid>');
        process.exit(1);
    }
    const { targets, others, unknown } = stopTargets(list, scope, wantAll);
    /** 止める／止めない相手を1行で出す（**repo を必ず添える**） */
    const line = (r, note) => `  PID ${r.pid}  port ${r.port ?? '?'}  ${describeCaps(r.cmd)}`
        + `${note}  ${repoOf(r.cmd) ?? '(repo 不明)'}`;
    /**
     * 🚨 **「別のリポジトリ」と「分からない」を言い分ける（#54）。**
     *    コマンド行から repo が読めなかった相手を「別のリポジトリ」と断言すると、
     *    止め残しに気付けない（「--stop したのに動いている」の原因になる）。
     */
    const showSkipped = () => {
        for (const r of others) console.log(line(r, '  ← 別のリポジトリなので止めません'));
        for (const r of unknown) {
            console.log(line(r, '  ← リポジトリが分からないので止めません'));
        }
        if (unknown.length) {
            console.log('  ⚠ 上の相手はコマンド行から repo を読めませんでした。'
                + '止めるなら --all か、PID を指定して手で止めてください');
        }
    };
    if (!targets.length) {
        console.log(wantAll
            ? '動いている kjp-edit はありません'
            : `このリポジトリの kjp-edit は動いていません: ${scope}`);
        // ⚠️ 「無い」と言った直後に、**止めない相手が居ることを必ず言う**
        //    （「--stop したのに動いている」の原因がこれになる）
        showSkipped();
        if (others.length || unknown.length) {
            console.log('  マシン上の全部を止めるなら: node scripts/serve.mjs --stop --all');
        }
        process.exit(0);
    }
    // 🚨 **道連れにする前に見せる。** 以前の出力は PID と port だけで、
    //    どのリポジトリを止めたか・何本の子孫を巻き込むかを一言も言わなかった
    //    （`--status` は repo を出しているので片方だけ欠けた非対称）。
    const kids = await descendantCounts(targets.map(r => r.pid));
    console.log(`これを止めます（${targets.length} 本。子プロセスも一緒に落ちます）:`);
    for (const r of targets) {
        const n = kids.supported
            ? `  子孫 ${kids.counts.get(r.pid) ?? 0} 個`
            : '  子孫の数は不明';
        console.log(line(r, n));
    }
    if (!kids.supported) {
        console.log(`  ⚠ 巻き込む子プロセスの数は調べられませんでした: ${kids.why}`);
    }
    if (wantAll) console.log('  （--all なので他のリポジトリのデーモンも含みます）');
    showSkipped();
    // 🚨 **`process.kill(pid)` では孫が残る。** Windows の `process.kill` は
    //    TerminateProcess 相当なので、対象の `process.on('SIGTERM')` が**走らない**。
    //    そのハンドラが `killTree()`（`taskkill /T /F`）を呼ぶ唯一の場所なので、
    //    `--stop` 経路ではプロセス木が一切掃除されず、**exec が立てた孫
    //    （`cmd /c npm test` の中身、`claude -p` の子）が残る**。
    //    `server.mjs` に「Windows の child.kill() は TerminateProcess 相当で
    //    その1プロセスしか殺さない」と自分で書いてあるのに、停止経路がそれを迂回していた。
    //    「停止しました」と書く前に本当に停止したかを確かめる（6回目のレビュー）。
    let failed = 0;
    for (const r of targets) {
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
    const outcome = stopOutcome({ after, targets, failed });
    // 🚨 **「調べられない」を「止まりました」と読まない**（#31 と同型が同じ関数の中に残っていた）
    if (outcome.unknown) {
        console.log(`⚠ 止まったかどうか確認できませんでした: ${after.why}`);
        console.log('  「停止しました」とは言えません。確認してください:');
        console.log('      node scripts/serve.mjs --status');
    } else if (outcome.left.length) {
        console.log(`⚠ まだ動いています: ${outcome.left.map(p => `PID ${p}`).join(', ')}`);
    }
    process.exit(outcome.exit);
}

// ---- リポジトリを見つける（--repo は複数指定できる。1本目が既定） ----
const repoCheck = collectRepos(argv);
if (repoCheck.error !== undefined) {
    console.error('\n✖ --repo にパスを指定してください'
        + `（受け取った値: ${repoCheck.error ?? '(無し)'}）\n`);
    process.exit(1);
}
const repos = [];
for (const given of (repoCheck.repos.length ? repoCheck.repos : [process.cwd()])) {
    // ⚠️ **1本ずつ解決する。** 1本でも開けなければ止める（黙って落とすと
    //    「登録したつもりのリポジトリが一覧に無い」を後で気付くことになる）。
    const top = await topLevel(given);
    if (!top) {
        console.error(`\n✖ git リポジトリが見つかりません: ${given}`);
        console.error('  --repo でパスを指定してください（複数可）\n');
        process.exit(1);
    }
    // 同じ場所を2回渡されたら1本にまとめる（サーバ側でも潰すが、案内も1本にする）
    if (!repos.some(r => samePathish(r, top))) repos.push(top);
}
// 二重起動の判定と表示は1本目（既定）で行う
const repo = repos[0];

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
// 🚨 **1本目だけで判定しない（#61）。** 複数 repo のデーモンが既に
//    このリポジトリを配信していても「動いていない」と読み、2本目が立ち上がっていた。
const already = probe.list.find(r => servesRepo(r.cmd, repo) === true);
// 🚨 **他に動いているデーモンを黙らせない（#55）。** 別リポジトリの2本目は
//    正しく立ち上がるが、今まで一言も言わなかったので「今マシン上で何本
//    動いているか」を --status を打つまで知る手段が無かった
//    （実行枠・監査・watcher が別々に増える）。
{
    const note = otherDaemonsNote(probe, repo);
    if (note) {
        console.log(`ℹ 他に ${note.count} 本の kjp-edit が動いています（--status で一覧）:`);
        for (const l of note.lines.slice(0, 5)) console.log(`    ${l}`);
        if (note.lines.length > 5) console.log(`    …他 ${note.lines.length - 5} 本`);
    }
}
if (already) {
    console.log(`既に動いています → http://127.0.0.1:${already.port ?? '?'}`);
    console.log(`  PID ${already.pid}  repo ${repo}`);
    // 🚨 **動いているものの capability を必ず出す。** 以前は URL だけを出していたので、
    //    先に `--exec` のデーモンが動いていると、素の `node scripts/serve.mjs`
    //    （読み取り専用のつもり）が「既に動いています → URL」と出して exit 0 し、
    //    **案内した先が RCE 可能なデーモンであることを1文字も言わなかった**。
    console.log(`  動いているもの: ${describeCaps(already.cmd)}`);
    // 🚨 **打ったフラグを黙って捨てない**（#30 と同じ根拠）。しかも**値まで比べる**。
    //    capability の名前だけ比べていたので `--timeout 3600` は集合に入らず、
    //    `--allow-host box-b` は値を見ていなかった = **要求が黙って無効**だった
    //    （前のデーモンが 600 秒のまま／スマホからは 403 のまま。8回目のレビュー）。
    // 🚨 **リポジトリの本数も「値まで比べる」対象に入れる。** 二重起動の判定は
    //    1本目でしているので、これが無いと `--repo A --repo B` を打った人に
    //    「既に動いています（A のデーモン）」と答えて exit 0 し、**B が見えない
    //    ことを1文字も言わない**（`--timeout` を集合に入れていなかったのと同型）。
    // ⚠️ 渡すのは**解決済み**の `repos`。argv の生の値（`.` や相対パス）は
    //    デーモンのコマンド行の絶対パスと一致しないので、必ず差分に見えてしまう。
    const diffs = configDiff(argv, already.cmd, { repos });
    if (diffs.length) {
        console.error('\n✖ 要求した設定が動いているものと違います:');
        for (const d of diffs) {
            console.error(`    ${d.what}: 要求 ${d.want} / 動いているもの ${d.have}`);
        }
        console.error('  黙って無視すると「打ったのに効かない」状態になります。');
        console.error('  入れ直してください:');
        // ⚠️ 打った引数をそのまま見せる（スクリプトの絶対パスは出さない。読みにくいだけ）
        const q = a => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
        console.error(`      node scripts/serve.mjs --stop --repo ${q(repo)}`);
        console.error(`      node scripts/serve.mjs ${argv.map(q).join(' ')}\n`);
        process.exit(1);
    }
    // ⚠️ `--stop` は**カレントのリポジトリ**が対象なので、repo を添えて案内する
    //    （別の場所から打つと「止めたのに動いている」になる）
    console.log(`  止めるには: node scripts/serve.mjs --stop --repo ${repo}`);
    process.exit(0);
}

// ---- ポートを決める（黙って変えない。値の検証は起動口の入口で済ませてある） ----
let port = portCheck.port;
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
        // ⚠️ 掴んでいるのは**別のリポジトリ**のデーモンかもしれない。`--stop` は
        //    カレントのリポジトリだけを止めるので、相手の repo を添えて案内する
        console.log('  止めるには: node scripts/serve.mjs --stop --repo '
            + `${repoOf(holder.cmd) ?? '<path>'}`);
    }
    // 🚨 **トンネルの向き先が動いたことを言う（#55）。** 母艦では正常に見えるのに
    //    スマホからだけ繋がらない（手元では絶対に気付けない壊れ方）。
    for (const l of portShiftNote({ from: port, to: found, hosts: hostCheck.hosts })) {
        console.log(l);
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

// 🔒 capability の分界（--exec ⊃ --write、観測は独立）と、トークンの永続化、
//    引き継ぎは serveargs.mjs の純関数に集約している（テストで固定）。
const args = serverArgs({
    argv, server: SERVER, repos, port,
    // 🚨 **読み取り用と実行用を同じ値にしない**（6回目のレビュー）。
    //    読み取り用の URL をスマホで開くことが、実行トークンを配ることになっていた。
    tokenFile: join(STATE_DIR, 'token-read'),
    // 🚨 write も別の値にする（読み取り用として配ったトークンで checkout させない）
    writeTokenFile: join(STATE_DIR, 'token-write'),
    execTokenFile: join(STATE_DIR, 'token-exec'),
    auditLog: join(STATE_DIR, 'exec-audit.jsonl'),
    devicesFile: join(STATE_DIR, 'devices.json'),
    reposFile: join(STATE_DIR, 'repos.json'),
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
/**
 * 🚨 **`token-read` に「実際に読み取りが通る値」を書く（#59）。**
 *
 * `--exec` のときは `--token-file` に**実行トークン**を渡すので、
 * サーバが読み取りとして受け付けるのは**そこから派生した秘密**（案内 URL の
 * `?token=` に載る値）だけで、`token-read` に残っていた古い生の値では**通らない**。
 * 実測: フックが毎回 401 を受け、`ask` に倒れて初めて気付いた。
 * 「読み取り用トークンはこのファイル」と書いてある以上、中身を事実に合わせる。
 * ⚠️ 派生の式は `v0/readsecret.mjs` の1本（サーバもここを通る）。
 */
{
    const i = args.indexOf('--token-file');
    const tokenFile = i >= 0 ? args[i + 1] : null;
    // ⚠️ 変数名を `readFile` にしない（`node:fs/promises` の import を覆い隠して
    //    「文字列を関数として呼ぶ」TypeError になる。しかも spawn の後なので
    //     デーモンだけ残って起動口が落ちる）
    const readTokenPath = join(STATE_DIR, 'token-read');
    // 🚨 読み取り専用のときは `--token-file` が token-read 自身なので、
    //    書き戻すと**起動のたびに鍵が回る**（10回目のレビュー / SERIOUS）
    if (tokenFile && shouldWriteReadSecret(tokenFile, readTokenPath)) {
        // サーバが生成する場合があるので、出るまで少し待つ（出なければ黙って諦める）
        for (let n = 0; n < 40; n++) {
            const raw = await readFile(tokenFile, 'utf8').catch(() => null);
            const secret = readSecretOf(raw?.trim());
            if (secret) {
                await writeFile(readTokenPath, `${secret}\n`,
                    { encoding: 'utf8', mode: 0o600 }).catch(() => {});
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

// 状態を書き残す（--status が PowerShell に頼らずに済む足がかり。今は参考情報）
await writeFile(join(STATE_DIR, 'last.json'),
    `${JSON.stringify({ repo, repos, port, exec: wantExec, write: wantWrite, pid: child.pid }, null, 1)}\n`,
    'utf8');
void dirname;
