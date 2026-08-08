#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// ログオン時に自動起動する登録／解除。
//
//   node scripts/autostart.mjs status
//   node scripts/autostart.mjs install [--repo <path>]... [--port 7749] [--write] [--exec]
//
// ⚠️ `--repo` は複数指定できる（1本目が既定）。**引き継ぎを落とすと
//    「ログオン後だけ1本に戻る」**という手元では気付けない壊れ方になる。
//   node scripts/autostart.mjs uninstall
//
// ⚠️ **既定は読み取り専用で登録する。** `--write` / `--exec` を明示しない限り
//    capability は付けない。ログオンのたびに立ち上がるものに書き込みや実行を
//    黙って持たせない（`docs/auth-ordering.md` の「既定オフ」と同じ思想）。
//
// ⚠️ **`schtasks /SC ONLOGON` は使えない。** 管理者権限を要求され
//    「アクセスが拒否されました」で失敗する（実測）。
//    代わりに **HKCU の Run キー**を使う。ユーザ単位で管理者不要（実測で確認）。
//
// ⚠️ `.ps1` / `.bat` / `.vbs` を作らない（CLAUDE.md）。`reg.exe` を
//    argv 配列で spawn するだけにする（shell を経由しない）。
//    その代わり**ログオン時にコンソール窓が出る**。窓を消すには `.vbs` が
//    必要になるので、規則を守る方を採った（ローカルのデーモンなので
//    窓が見えて閉じられるのは利点でもある）。

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 🚨 Run キーの値は CreateProcess の lpCommandLine としてそのまま CRT に解釈される。
//    素朴な "..." 囲みでは末尾がバックスラッシュの値で引用が閉じない（#29）。
import { winQuote, trimTrailingSep } from './winargs.mjs';
// 🚨 引き継ぎ（--allow-host / 観測フラグ）は落ちても**手元では気付けない**
//    （再起動後だけ 403 / ログオン後だけパネルが消える）。純関数にして固定した（#45）
import {
    AUTOSTART_FLAGS, unknownFlag, checkPort, collectRepos, autostartServeArgs,
} from './serveargs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVE = join(ROOT, 'scripts', 'serve.mjs');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'kjp-edit';

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) ?? 'status';
const has = f => argv.includes(f);
const val = (f, d) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

function run(file, args) {
    return new Promise(res => {
        execFile(file, args, { windowsHide: true, encoding: 'utf8' },
            (e, out, err) => res({ code: e?.code ?? 0, out: out ?? '', err: err ?? '' }));
    });
}

if (process.platform !== 'win32') {
    console.log(`このスクリプトは Windows 専用です（${process.platform} は未対応）。`);
    console.log('\n手動で登録する場合の中身:');
    console.log(`  ${process.execPath} ${SERVE} --repo <path>`);
    console.log('\n  macOS: ~/Library/LaunchAgents/ に plist を置く');
    console.log('  Linux: systemd --user のユニットを書く');
    console.log('  ⚠️ どちらも既定は読み取り専用にすること（--write / --exec を付けない）');
    process.exit(0);
}

/** 登録されているコマンド行を返す（無ければ null） */
async function current() {
    const r = await run('reg', ['query', RUN_KEY, '/v', NAME]);
    if (r.code !== 0) return null;
    // "    kjp-edit    REG_SZ    <値>"
    const m = /REG_SZ\s+(.*)$/m.exec(r.out);
    return m ? m[1].trim() : null;
}

if (cmd === 'status') {
    const v = await current();
    if (!v) {
        console.log('自動起動は登録されていません');
        console.log(`  登録するには: node scripts/autostart.mjs install --repo ${ROOT.replace(/\\/g, '/')}`);
        process.exit(0);
    }
    const caps = [/--exec/.test(v) && '実行', /--write/.test(v) && '書き込み']
        .filter(Boolean).join('+') || '読み取り専用';
    const host = /--allow-host\s+(\S+)/.exec(v)?.[1];
    const watch = /--agents-text/.test(v) ? '活動観測+発話'
        : /--watch\b/.test(v) ? '活動観測' : null;
    console.log(`登録されています（ログオン時 / ${caps}`
        + `${watch ? ` / ${watch}` : ''}`
        + `${host ? ` / Host 許可: ${host}` : ''}）`);
    console.log(`  中身: ${v}`);
    // 🚨 **登録した文字列が壊れていないかを status で言う。** 以前は引用が
    //    閉じていない値でも「登録されています」と出し続けたので、
    //    再起動するまで壊れていることに気付けなかった（#29）。
    const quotes = (v.match(/(?<!\\)"/g) ?? []).length;
    if (quotes % 2 !== 0) {
        console.log('');
        console.log('🚨 登録されている文字列の引用が閉じていません。');
        console.log('   このままではログオン時に起動に失敗します（--port や --allow-host が');
        console.log('   repo 引数に飲まれます）。登録し直してください:');
        console.log('     node scripts/autostart.mjs install');
    }
    console.log('  解除するには: node scripts/autostart.mjs uninstall');
    process.exit(0);
}

if (cmd === 'uninstall') {
    if (!(await current())) { console.log('登録されていません（何もしません）'); process.exit(0); }
    const r = await run('reg', ['delete', RUN_KEY, '/v', NAME, '/f']);
    console.log(r.code === 0 ? '自動起動を解除しました'
        : `解除できませんでした: ${(r.err || r.out).trim()}`);
    process.exit(r.code === 0 ? 0 : 1);
}

if (cmd !== 'install') {
    console.error(`不明なコマンド: ${cmd}（status / install / uninstall）`);
    process.exit(1);
}

// ---- install ----
// 🚨 **知らないフラグを黙って捨てない。** 捨てると「打ったのに効かない」が
//    起動するまで分からない（#30）。**他の検証より先に置く**（後ろに置くと、
//    この門を外したときに壊れた登録が先に出来上がる余地が残る）。
{
    const bad = unknownFlag(argv, AUTOSTART_FLAGS, 'このスクリプト');
    if (bad) {
        console.error(`\n✖ 知らないオプションです: ${bad.flag}${bad.hint}`);
        console.error(`  使えるもの: ${bad.known.join(' ')}\n`);
        process.exit(1);
    }
}

// ⚠️ 末尾のセパレータを落とす。残すと CRT の引用規則を踏みやすく、
//    どのツールでも意味は変わらないので落として良い（**既定値 ROOT がこの形**）。
// 🚨 **`--repo` は複数指定できる。1本目だけ読んで残りを捨てない**
//    （捨てると「ログオン後だけ1本に戻る」= 手元では気付けない壊れ方）。
const repoCheck = collectRepos(argv);
if (repoCheck.error !== undefined) {
    // `--allow-host` は検証しているのに `--repo` が無検証、という非対称が
    // #29 の原因だった。引用を壊す文字は最初から弾く。
    console.error('\n✖ --repo に使えない文字が入っています（" や改行）: '
        + `${JSON.stringify(repoCheck.error)}\n`);
    process.exit(1);
}
const repos = (repoCheck.repos.length ? repoCheck.repos : [ROOT]).map(trimTrailingSep);
// 🚨 **登録するパスは「解決した絶対パス」にする（#74。10回目のレビュー / SERIOUS）。**
//
// `serve.mjs` は `topLevel()` で1本ずつ解決し、開けなければ起動を止める。
// install には同じ門が無く、`--repo .` や実在しないパスをそのまま REG_SZ に書いて
// 「自動起動を登録しました」と表示していた。Run キーから起動されるプロセスの
// 作業ディレクトリは %USERPROFILE% 等で git リポジトリではないので、
// **ログオン時にだけ exit 1** する（コンソール窓が一瞬出て消えるだけ）。
// `--allow-host` の引き継ぎ漏れ（#29）とまったく同じ壊れ方で、
// しかも同じファイルが「`--allow-host` は検証しているのに `--repo` が無検証、
// という非対称が #29 の原因だった」と書いている**その非対称が残っていた**。
{
    const resolved = [];
    for (const r of repos) {
        const t = await run('git', ['-C', r, 'rev-parse', '--show-toplevel']);
        const top = (t.out ?? '').trim();
        if (t.code !== 0 || !top) {
            console.error(`\n✖ git のリポジトリとして開けません: ${r}`);
            console.error('  登録すると**ログオン時にだけ**起動に失敗します'
                + '（手元では気付けない形で壊れます）。');
            console.error('  存在する worktree かリポジトリのパスを渡してください\n');
            process.exit(1);
        }
        // ⚠️ **解決した絶対パスを書く**（相対パスは Run キーの作業ディレクトリで別物になる）
        resolved.push(trimTrailingSep(top));
    }
    repos.length = 0;
    repos.push(...resolved);
}

const portCheck = checkPort(val('--port', undefined), '7749');
if (portCheck.error !== undefined) {
    console.error(`\n✖ --port には 1〜65535 を指定してください（受け取った値: ${portCheck.error}）\n`);
    process.exit(1);
}
const port = String(portCheck.port);

// ⚠️ `--allow-host` と観測フラグの引き継ぎは serveargs.mjs でテストに固定してある。
//    落ちると**再起動後だけ 403 / ログオン後だけパネルが消える**形で壊れる。
const built = autostartServeArgs({ argv, repos, port });
if (built.error !== undefined) {
    console.error('\n✖ --allow-host にはホスト名を指定してください'
        + `（受け取った値: ${built.error ?? '(無し)'}）\n`);
    process.exit(1);
}
const serveArgs = built.args;

// Run キーの値は1つの文字列。**CRT の規則に合わせて引用する**（scripts/winargs.mjs）。
const value = [process.execPath, SERVE, ...serveArgs].map(winQuote).join(' ');

// 🚨 **検査用: 登録の手前で止める（--dry-run）。**
//    #74 の門（開けないパスを拒否する）を変異で測るには install を実際に走らせる必要が
//    あるが、門を外した変異は**利用者の Run キーに嘘の登録を書いてしまう**。
//    そこで「レジストリに触る手前で止める」経路を用意する。
//    ⚠️ 既定では存在しない挙動で、書き込みだけを飛ばす（検証と組み立ては全部通る）。
if (has('--dry-run')) {
    console.log('（--dry-run なので登録していません）');
    console.log(value);
    process.exit(0);
}
const r = await run('reg', ['add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', value, '/f']);
if (r.code !== 0) {
    console.error(`✖ 登録できませんでした: ${(r.err || r.out).trim()}`);
    process.exit(1);
}
const caps = has('--exec') ? '実行+書き込み' : has('--write') ? '書き込み' : '読み取り専用';
// ⚠️ **登録時と status で同じものを出す。** 片方だけに出すと
//    「登録できたのか」を確認する手段がずれる（#30 の指摘と同じ形）
const watchLabel = has('--agents-text') ? ' / 活動観測+発話'
    : has('--watch') ? ' / 活動観測' : '';
console.log(`自動起動を登録しました（ログオン時 / ${caps}${watchLabel}）`);
// 🚨 **登録した本数を全部出す。** 1本しか出さないと、2本目が引き継がれて
//    いるかを確認する手段が「再起動して見る」だけになる
console.log(`  repo: ${repos.join('\n        ')}`);
console.log(`  URL : http://127.0.0.1:${port}`);
console.log(`  中身: ${value}`);
console.log('\n  ⚠️ ログオン時にコンソール窓が出ます（.vbs を作らない方針のため）');
console.log('  解除する: node scripts/autostart.mjs uninstall');
if (has('--exec')) {
    console.log('\n🚨 実行を有効にして登録しました。ログオンのたびに、任意コマンドを');
    console.log('   走らせられるデーモンが立ち上がります。トンネルを開ける前に');
    console.log('   docs/auth-ordering.md の「残っているリスク」を読んでください。');
}
