#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// UI のレイアウトを実際のブラウザで測る。狭い画面で情報が消えていないかを見る。
//
//   node v0/layout-check.mjs [--repo <path>]
//
// なぜ必要か（実際に踏んだ3件。いずれも「見た目で気付けない」種類）:
//   1. grid/flex アイテムの min-width は既定 auto。グラフの SVG が列を押し広げ、
//      body ごと viewport より広くなっていた
//   2. `auto` 幅の grid 列にパーセント max-width を書くと幅が循環参照になり、
//      ref バッジが `a…` `HE…` のように1〜2文字へ潰れていた
//   3. バッジを overflow:hidden の .subject の中に入れていたため、狭い画面で
//      **完全に見えなくなり、横スクロールでも到達できず、溢れとしても検出されなかった**
//
// Chrome/Edge が無い環境（CI 等）では**スキップして exit 0**。
// ブラウザは検査にしか使わないので、プロジェクトの依存パッケージは増えない。

import { spawn, execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

const CANDIDATES = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

async function findBrowser() {
    for (const p of CANDIDATES) {
        try { await access(p); return p; } catch { /* 次を試す */ }
    }
    return null;
}

const repoArg = process.argv.indexOf('--repo');
const repo = repoArg !== -1 ? process.argv[repoArg + 1] : process.cwd();

// 🚨 **検査用のトークン。** サーバ起動とハーネスの URL で同じ値を使う
//    （別々に書くと片方だけ変えて「描かれないのに緑」に戻る）。
const TOKEN = 'layout-check-token-0123456789';

/**
 * 🚨 **verify の上限（240s）より前に、自分で理由を出して落ちる。**
 *
 * 以前は上限で SIGKILL され、`✖ layout 240.0s` の1行だけが残って
 * **何を待っていたか消えていた**（macOS の CI で実際にこれを踏んだ）。
 * 「打ち切られた結果を緑と読まない」の裏返しで、**打ち切るなら理由を残す**。
 */
const DEADLINE_MS = 200_000;
const startedAt = Date.now();
const leftMs = () => DEADLINE_MS - (Date.now() - startedAt);
/** 経過を必ず出す（verify は失敗時に末尾を見せるので、ここが手掛かりになる） */
const step = [];
const note = (what, ms) => {
    step.push(`${what} ${(ms / 1000).toFixed(1)}s`);
    console.log(`  · ${what} ${(ms / 1000).toFixed(1)}s（残り ${Math.round(leftMs() / 1000)}s）`);
};

const browser = await findBrowser();
if (!browser) {
    console.log('– layout: skipped (Chrome/Edge が見つからない)');
    process.exit(0);
}

/**
 * 🚨 **2本目のリポジトリを用意する。**
 *
 * リポジトリのセレクトは**登録が1本のときは描かない**（選ぶものが無い操作を
 * 出さないため）。つまり1本で起動した検査では**セレクトが1度も測られない**
 * =「390px でトップバーが溢れても気付けない」。
 * `--allow-exec` が無いとコマンドバーを測れなかったのと同じ形なので、
 * 検査側で2本目を作る（中身は空のリポジトリで足りる。測るのは幅だけ）。
 */
const g2 = (args, cwd) => new Promise(res => execFile('git', args,
    { cwd, windowsHide: true, encoding: 'utf8' }, () => res()));
const repo2 = await mkdtemp(join(tmpdir(), 'kjp-layout-repo2-'));
await g2(['init', '-q', '-b', 'main'], repo2);
await g2(['config', 'user.email', 'a@b'], repo2);
await g2(['config', 'user.name', 'a'], repo2);
await writeFile(join(repo2, 'f.txt'), 'x\n', 'utf8');
await g2(['add', '-A'], repo2);
await g2(['commit', '-q', '-m', 'seed'], repo2);

// サーバを起動して URL を得る
const server = spawn(process.execPath,
    // ⚠️ 活動観測と**実行**も有効にする。--allow-exec が無いと
    //    コンソールは「実行は無効です」の一文になり、**コマンドバー
    //    （select + 入力 + ボタン3つ）が描かれないので測れない**。
    //    ボタンを1つ足したときに 390px で溢れても気付けなかった。
    // ⚠️ `--repo` を2本渡すのはリポジトリのセレクトを描かせるため（上のコメント）。
    //    **1本目が既定**なので、他の検査の対象は変わらない。
    [SERVER, '--repo', repo, '--repo', repo2, '--port', '0', '--layout-probe', '--watch-agents',
        '--allow-exec', '--token', TOKEN, '--allow-write'],
    { shell: false, windowsHide: true });
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');

let baseUrl;
try {
    baseUrl = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('サーバが起動しなかった')), 15000);
        let buf = '';
        server.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        server.stderr.on('data', d => { clearTimeout(t); reject(new Error(d)); });
        server.on('error', reject);
    });
} catch (err) {
    server.kill();
    console.log(`✖ layout: サーバ起動に失敗 — ${err.message}`);
    process.exit(1);
}

/** ハーネスを開いて JSON を取り出す */
async function measure(width, from = null) {
    const at = from ?? baseUrl;
    const profile = await mkdtemp(join(tmpdir(), 'kjp-layout-'));
    const child = spawn(browser, [
        // ⚠️ `--headless=old` は Chrome 132 で削除された。`=new` を使う
        //    （どちらでも iframe 幅は正しく効くことを実測済み）。
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking',
        // CI のコンテナでは sandbox が使えないことがある。ローカルでは付けない。
        ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        // ⚠️ 予算が足りないと、ハーネスが `#out` を書く前に DOM が dump される。
        //    そうなると全幅で「計測結果が取れなかった」になり、**何が壊れたのか
        //    まったく分からない**（並び替えの計測でこれを踏んだ）。
        //    ハーネスは自動更新1回と再読込1回を通すので 8000 では足りない。
        `--user-data-dir=${profile}`, '--window-size=1200,2100',
        // ⚠️ 予算は main 側の 30000（ドラッグ検査は reload を含むので 8000 では足りない）
        '--virtual-time-budget=30000', '--dump-dom',
        // ⚠️ `at` は測る対象のサーバ（1本構成の2台目も測るため）
        `${at}/__probe?w=${width}&token=${TOKEN}`,
    ], { shell: false, windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    // ⚠️ 撮影後にブラウザを必ず落とす。放置すると同時実行で数十プロセス残る（実際に53個残した）
    const done = new Promise(r => child.on('close', r));
    // ⚠️ **上限は「残り時間」に合わせる。** 固定 60s だと、4本立ち上げるだけで
    //    verify の上限（240s）に達し、**外から SIGKILL されて理由が消える**。
    const budget = Math.max(15_000, Math.min(60_000, leftMs() - 20_000));
    let browserKilled = false;
    const kill = setTimeout(() => { browserKilled = true; child.kill('SIGKILL'); }, budget);
    const t0 = Date.now();
    await done;
    clearTimeout(kill);
    note(`幅 ${width} を測った`, Date.now() - t0);
    if (browserKilled) {
        await rm(profile, { recursive: true, force: true }).catch(() => {});
        throw new Error(`幅 ${width}: ブラウザが ${Math.round(budget / 1000)}s で終わらなかった`
            + '（SIGKILL）。--virtual-time-budget は実時間の上限ではないので、'
            + 'ページの fetch が返っていない可能性がある');
    }
    await rm(profile, { recursive: true, force: true });

    if (leftMs() <= 0) {
        throw new Error(`締切（${DEADLINE_MS / 1000}s）を超えました。経過: ${step.join(' / ')}`);
    }
    const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error(`幅 ${width}: 計測結果が取れなかった`);
    const decode = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return JSON.parse(decode(m[1]));
}

/**
 * 🚨 **監視盤の行を測るには、走っているセッションが1本必要。**
 *
 * 行が無いと監視盤は「セッションはありません」の一文で、
 * **入力欄もボタンも描かれない = 狭い画面で溢れても気付けない**。
 * ⚠️ keepAlive にする（購読をすぐ切るので、猶予で殺されると測る前に消える）。
 * ⚠️ 起動したものは finally で必ず止める（取り残しを作らない）。
 */
async function startProbeSession() {
    let id = null;
    let reader = null;
    try {
        const res = await fetch(`${baseUrl}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e', 'setTimeout(() => {}, 120000)'],
                keepAlive: true,
            }),
        });
        // 1行目が {t:"session", id}。id を取ったら購読はやめる（走り続ける）
        reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (let i = 0; i < 50 && id === null; i++) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const nl = buf.indexOf(String.fromCharCode(10));
            if (nl === -1) continue;
            const rec = JSON.parse(buf.slice(0, nl));
            if (rec.t === 'session') id = rec.id;
        }
    } catch (err) {
        console.log(`   ⚠ 監視盤用のセッションを起動できませんでした: ${err.message}`);
    } finally {
        // 🚨 **AbortController で切らない。** Windows では、閉じかけの handle を
        //    abort すると libuv が
        //    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` で**異常終了**し、
        //    「✔ layout」を出した直後に exit が 0 でなくなる
        //    （検査は通っているのに落ちて見える。実測）。
        //    reader を cancel すれば本文が正しく閉じ、サーバも切断を検知する。
        try { await reader?.cancel(); } catch { /* 既に閉じている */ }
    }
    return id;
}

/**
 * 🚨 **1本だけ登録した構成も測る。**
 *
 * 「登録が1本ならセレクトを出さない」は**2本で起動している検査では絶対に落ちない**
 * （突然変異 `repo-select-hidden-when-single` が実際に SURVIVED した）。
 * 出さないことを主張するなら、出さない構成を1回描いて数えるしかない。
 * ⚠️ `hidden` を付けても作者スタイルに負けると描かれるので、**件数で見る**
 *    （`drawnRepoOptions` は描かれていなければ 0）。
 */
let single = null;
async function startSingleRepoServer() {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--layout-probe',
            '--allow-exec', '--token', TOKEN],
        { shell: false, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buf = '', err = '';
    child.stderr.on('data', d => { err += d; });
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(
            `1本構成のサーバが起動しなかった: ${err.trim() || '(stderr は空)'}`)), 15000);
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    return { child, url };
}

const problems = [];
const lines = [];
let probeSession = null;
try {
    probeSession = await startProbeSession();
    if (probeSession === null) {
        problems.push('監視盤用のセッションが起動できなかった（行を測れない）');
    }
    for (const width of [390, 768, 1280]) {
        const r = await measure(width);
        // iframe の幅が指定通りでないと、測っている対象が違う
        if (r.innerWidth !== width) {
            problems.push(`幅 ${width}: iframe の innerWidth が ${r.innerWidth} になっている`);
        }
        const overflows = r.bodyScrollWidth > r.bodyClientWidth + 1;
        if (overflows) {
            problems.push(`幅 ${width}: body が横に溢れている `
                + `(${r.bodyScrollWidth} > ${r.bodyClientWidth}) — ${r.overflowing.join(', ')}`);
        }
        // 🚨 hidden なのに描かれている = 押しても無反応の操作が出ている
        if (r.hiddenButDrawnCount > 0) {
            problems.push(`幅 ${width}: hidden なのに描かれている要素がある `
                + `(${r.hiddenButDrawn.join(', ')})`);
        }
        if (r.squashedCount > 0) {
            problems.push(`幅 ${width}: バッジが幅24px未満に潰れている `
                + `${r.squashedCount} 個 — ${r.squashedBadges.join(', ')}`);
        }
        // どの幅でも worktree HEAD は見えていなければならない。
        // これが 0 になるのは「どのコミットがどのエージェントの HEAD か」が
        // 消えた状態で、観測ツールとして意味を失う。
        if (r.visibleWorktreeBadges === 0) {
            problems.push(`幅 ${width}: worktree HEAD バッジが1つも描かれていない`);
        }
        // 🚨 **測っている対象が本当に描かれていることを確かめる。**
        //    トークンが無いと実行系の UI は「使えません」の一文になり、
        //    溢れも hidden も測らないまま緑になる（この検査は実際にその状態だった。
        //    「コマンドバーを測っている」というコメントが**嘘**になっていた）。
        if (r.drawnCmdbars === 0) {
            problems.push(`幅 ${width}: コマンドバーが1つも描かれていない`
                + '（実行系の UI を測れていない = 溢れても気付けない）');
        }
        if (r.drawnMonitorRows === 0) {
            problems.push(`幅 ${width}: 監視盤の行が1つも描かれていない`
                + '（セッションを走らせて測る前提が崩れている）');
        }
        // 🚨 トップバーからはみ出した操作は横スクロールでも到達できない
        //    （overflow:hidden + nowrap）。body の溢れとしては出ないので別に見る。
        if (r.topbarClippedCount > 0) {
            problems.push(`幅 ${width}: トップバーの操作が枠外に押し出されている `
                + `(${r.topbarClipped.join(', ')}) — 押せないボタンになっている`);
        }
        // 🚨 **狭い画面ではセレクトとパスが入れ替わる**という約束を効果で測る。
        //    CSS の書き間違い（コメントの閉じ忘れ等）はブラウザが規則を黙って
        //    捨てるので、構文チェックでは絶対に見つからない（実際に踏んだ）。
        if (width <= 1100 && r.repoPathDrawn) {
            problems.push(`幅 ${width}: セレクトを出しているのにパスの表示も残っている`
                + '（トップバーは伸びも折り返しもしないので、要素を1つ足したら1つ引く。'
                + 'CSS の規則が落ちていないか見ること）');
        }
        // ⚠️ 広い画面では**両方出る**のが正しい（片方だけの検査にしない）
        if (width > 1100 && !r.repoPathDrawn) {
            problems.push(`幅 ${width}: 広い画面なのにパスの表示が消えている`
                + '（どのリポジトリのどこを見ているか分からない）');
        }
        // 🚨 2本登録して起動しているのに描かれていないなら、測っていない
        if (r.drawnRepoOptions < 2) {
            problems.push(`幅 ${width}: リポジトリのセレクトが描かれていない`
                + `（選択肢 ${r.drawnRepoOptions} 個。2本登録して起動しているので`
                + 'トップバーの幅を測れていない = 溢れても気付けない）');
        }
        // 🚨 **ペインの並び替え（ドラッグ移動）は実際に掴んで動かして測る。**
        //    保存も復元も「行は残っているのに到達不能」という形で壊せるので、
        //    字面ではなく副作用（並び順）だけを見る。
        const before = problems.length;
        if (!Array.isArray(r.dragNote)) {
            problems.push(`幅 ${width}: 並び替えの計測が返っていない（ハーネスが古い）`);
        } else if (r.dragNote.length) {
            // 測れなかったことを緑と読まない
            for (const n of r.dragNote) problems.push(`幅 ${width}: ${n}`);
        } else {
            const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
            // 🚨 **既定の並びに絶対の目印を1つ置く。** 「動かす前と後で同じ」だけを
            //    見ていると、既定の並びを決めている仕組み（render が求めた順）を
            //    丸ごと壊しても両方が同じように壊れて緑になる。
            //    worktree カードは一番見たいものなので、既定では #left の先頭。
            if (r.leftBefore[0] !== 'worktrees') {
                problems.push(`幅 ${width}: 既定の並びで #left の先頭が worktrees でない`
                    + `（${r.leftBefore.join(',')}）`);
            }
            const wantHead = r.rightBefore[0];
            const wantSecond = r.leftBefore[r.leftBefore.length - 1];
            if (r.leftAfterDrag[0] !== wantHead) {
                problems.push(`幅 ${width}: 列をまたぐ移動が効いていない`
                    + `（#left の先頭が ${r.leftAfterDrag[0]}、期待 ${wantHead}）`);
            }
            if (r.rightAfterDrag.length !== 0) {
                problems.push(`幅 ${width}: 移したペインが元の列に残っている`
                    + `（#right: ${r.rightAfterDrag.join(',')}）`);
            }
            if (r.leftAfterDrag[1] !== wantSecond) {
                problems.push(`幅 ${width}: 列の中の並び替えが効いていない`
                    + `（2番目が ${r.leftAfterDrag[1]}、期待 ${wantSecond}）`);
            }
            // 自動更新でペインを作り直したり並びを戻したりしてはいけない
            if (!eq(r.leftAfterRefresh, r.leftAfterDrag)) {
                problems.push(`幅 ${width}: 自動更新で並びが変わった`
                    + `（${r.leftAfterRefresh.join(',')} / 直後は ${r.leftAfterDrag.join(',')}）`);
            }
            if (r.paneDuplicates > 0) {
                problems.push(`幅 ${width}: 同じ id のペインが ${r.paneDuplicates} 個多い`
                    + '（差分更新ではなく作り直している）');
            }
            if (r.bodyScrollWidthAfterDrag > r.bodyClientWidthAfterDrag + 1) {
                problems.push(`幅 ${width}: 並べ替えた後に body が横に溢れている `
                    + `(${r.bodyScrollWidthAfterDrag} > ${r.bodyClientWidthAfterDrag})`
                    + ` — ${r.overflowingAfterDrag.join(', ')}`);
            }
            if (!eq(r.leftAfterReload, r.leftAfterDrag)) {
                problems.push(`幅 ${width}: 再読込で並びが復元されない`
                    + `（${r.leftAfterReload.join(',')} / 期待 ${r.leftAfterDrag.join(',')}）`);
            }
            if (r.rightAfterReload.length !== 0) {
                problems.push(`幅 ${width}: 再読込で移したペインが元の列に戻った`
                    + `（#right: ${r.rightAfterReload.join(',')}）`);
            }
            // 「レイアウト」で既定に戻せること（動かしすぎた画面の唯一の直し方）
            if (!eq(r.leftAfterReset, r.leftBefore) || !eq(r.rightAfterReset, r.rightBefore)) {
                problems.push(`幅 ${width}: 「レイアウト」で既定の並びに戻らない`
                    + `（#left ${r.leftAfterReset.join(',')} / 期待 ${r.leftBefore.join(',')}`
                    + ` / #right ${r.rightAfterReset.join(',')}）`);
            }
        }
        lines.push(`  ${String(width).padStart(4)}px: 横溢れ ${overflows ? '✖' : 'なし'}`
            + ` / worktree HEAD ${r.visibleWorktreeBadges} 個・ref 込み ${r.visibleBadges} 個`
            + ` / 潰れ ${r.squashedCount} / viewport 超過 ${r.overflowingCount} 件`
            + ` / コマンドバー ${r.drawnCmdbars} / 監視行 ${r.drawnMonitorRows}`
            + ` / 並び替え ${problems.length === before ? '✔' : '✖'}`
            + `（${(r.leftAfterReload ?? []).length} 本を復元）`
            + ` / repo選択 ${r.drawnRepoOptions} / bar枠外 ${r.topbarClippedCount}`);
    }
    // 1本だけ登録した構成: セレクトは**描かれてはいけない**
    single = await startSingleRepoServer();
    const one = await measure(390, single.url);
    if (one.drawnRepoOptions !== 0) {
        problems.push('リポジトリが1本しか登録されていないのにセレクトが描かれている'
            + `（選択肢 ${one.drawnRepoOptions} 個。選ぶものが無い操作を出している）`);
    }
    if (one.topbarClippedCount > 0) {
        problems.push(`1本構成の 390px でトップバーの操作が枠外に押し出されている `
            + `(${one.topbarClipped.join(', ')})`);
    }
    // 🚨 **セレクトを出さない構成では、パスを落としてはいけない。**
    //    「狭いから落とす」を無条件にすると、どのリポジトリを見ているかが
    //    どこにも出なくなる（`:has()` で条件を付けている理由そのもの）。
    if (!one.repoPathDrawn) {
        problems.push('1本構成の 390px でリポジトリ名がどこにも出ていない'
            + '（セレクトも無く、パスの表示も落ちている）');
    }
    lines.push(`   1本構成 390px: repo選択 ${one.drawnRepoOptions}（0 が正）`
        + ` / bar枠外 ${one.topbarClippedCount} / パス表示 ${one.repoPathDrawn}`);
} catch (err) {
    problems.push(err.message);
} finally {
    // 🚨 起動したセッションは必ず止める（Windows では server.kill() の
    //    SIGTERM でハンドラが走らないので、子が残る）
    if (probeSession) {
        try {
            await fetch(`${baseUrl}/api/v0/exec/${probeSession}/kill`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
            });
        } catch { /* サーバが既に落ちている */ }
    }
    server.kill();
    // 🚨 起動したサーバは全部止める（1本構成の方も。取り残しはポートを塞ぐ）
    try { single?.child.kill(); } catch { /* noop */ }
    // 🚨 検査が作ったリポジトリは必ず消す（取り残しは意志ではなく仕組みで防ぐ）
    await rm(repo2, { recursive: true, force: true }).catch(() => {});
}

console.log(problems.length ? '✖ layout' : '✔ layout');
for (const l of lines) console.log(l);
for (const p of problems) console.log(`  ${p}`);
// 🚨 **`process.exit()` で即死させない。** kill した子プロセスや閉じかけの
//    HTTP 本文の handle が残っている状態で即死すると、Windows の libuv が
//    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` で**異常終了コード**を返し、
//    「✔ layout」を出しているのに検査が落ちて見える（実測。原因を出力の中に探した）。
process.exitCode = problems.length ? 1 : 0;
