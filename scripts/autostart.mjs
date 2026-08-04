#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// ログオン時に自動起動する登録／解除。
//
//   node scripts/autostart.mjs status
//   node scripts/autostart.mjs install [--repo <path>] [--port 7749] [--write] [--exec]
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
// ⚠️ 末尾のセパレータを落とす。残すと CRT の引用規則を踏みやすく、
//    どのツールでも意味は変わらないので落として良い（**既定値 ROOT がこの形**）。
const repo = trimTrailingSep(val('--repo', ROOT));
if (!repo || /["\r\n\0]/.test(repo)) {
    // `--allow-host` は検証しているのに `--repo` が無検証、という非対称が
    // #29 の原因だった。引用を壊す文字は最初から弾く。
    console.error(`\n✖ --repo に使えない文字が入っています（" や改行）: ${JSON.stringify(repo)}\n`);
    process.exit(1);
}
const port = val('--port', '7749');
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    console.error(`\n✖ --port には 1〜65535 を指定してください（受け取った値: ${port}）\n`);
    process.exit(1);
}
const serveArgs = ['--repo', repo, '--port', port];
if (has('--exec')) serveArgs.push('--exec');
else if (has('--write')) serveArgs.push('--write');
// ⚠️ トンネル用のホスト名も引き継ぐ。これが無いと**再起動後だけ 403 になる**
//    （手元では気付かず、スマホから見たときに初めて分かる形の壊れ方をする）。
//    許可は明示的なオプトインのままにする（既定はループバックのみ）。
for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--allow-host') continue;
    const h = argv[i + 1];
    // ホスト名として妥当なものだけ。Run キーの値は1つの文字列なので、
    // 空白や引用符を混ぜられると別の引数に化ける
    if (!h || !/^[A-Za-z0-9._-]+$/.test(h)) {
        console.error(`\n✖ --allow-host にはホスト名を指定してください（受け取った値: ${h ?? '(無し)'}）\n`);
        process.exit(1);
    }
    serveArgs.push('--allow-host', h);
}
// ⚠️ 観測フラグも引き継ぐ。`--allow-host` を落としていたのと**同型の再発**で、
//    付けたつもりが読み取り専用で登録され、**ログオン後だけパネルが消える**。
if (has('--agents-text')) serveArgs.push('--agents-text');
else if (has('--watch')) serveArgs.push('--watch');

// 🚨 **知らないフラグを黙って捨てない。** 捨てると「打ったのに効かない」が
//    起動するまで分からない（#30）。serve.mjs 側の名前で打たれることが多いので、
//    正しい名前を示して止める。
const KNOWN = new Set(['--repo', '--port', '--write', '--exec', '--allow-host',
    '--watch', '--agents-text']);
const ALIAS = {
    '--allow-write': '--write',
    '--allow-exec': '--exec',
    '--watch-agents': '--watch',
    '--allow-transcript-text': '--agents-text',
};
for (const a of argv) {
    if (!a.startsWith('--') || KNOWN.has(a)) continue;
    const hint = ALIAS[a] ? `（このスクリプトでは ${ALIAS[a]} です）` : '';
    console.error(`\n✖ 知らないオプションです: ${a}${hint}`);
    console.error(`  使えるもの: ${[...KNOWN].join(' ')}\n`);
    process.exit(1);
}

// Run キーの値は1つの文字列。**CRT の規則に合わせて引用する**（scripts/winargs.mjs）。
const value = [process.execPath, SERVE, ...serveArgs].map(winQuote).join(' ');

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
console.log(`  repo: ${repo}`);
console.log(`  URL : http://127.0.0.1:${port}`);
console.log(`  中身: ${value}`);
console.log('\n  ⚠️ ログオン時にコンソール窓が出ます（.vbs を作らない方針のため）');
console.log('  解除する: node scripts/autostart.mjs uninstall');
if (has('--exec')) {
    console.log('\n🚨 実行を有効にして登録しました。ログオンのたびに、任意コマンドを');
    console.log('   走らせられるデーモンが立ち上がります。トンネルを開ける前に');
    console.log('   docs/auth-ordering.md の「残っているリスク」を読んでください。');
}
