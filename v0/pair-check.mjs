// SPDX-License-Identifier: MIT
//
// 🔑 **端末の承認を、実ブラウザで UI から通す検査**（`docs/device-approval.md`）。
//
// 🚨 **なぜ unit では足りないか。** 「どの鍵を送るか」の判断は `v0/devicekey.mjs` に
//    出してテストしてあるが、**どの枠から読むか**の配線は `app.html` の中にある。
//    ここを字面で assert すると「行を残して到達不能にする」変更が完全に見えない
//    （`docs/review-5-6-parallel.md` の `core.fsmonitor` / `pathspec magic` と同型）。
//    実際にこの配線で壊れた: 案内 URL の読み取り秘密を**貼った鍵と同じ枠**に入れていたので、
//    承認済みの端末で capability が「実行有効（トークン未取得）」のままになった。
//
// ⚠️ 合言葉は**母艦のファイルからしか読めない**（応答に載らない）。この検査は
//    母艦の側に居るのでファイルを読む。**それが承認の根拠そのもの**なので、
//    ここを HTTP から取れるようにしたらこの検査は意味を失う。
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, openPage, waitFor } from './cdp.mjs';
import { readSecretOf } from './readsecret.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browser = await findChrome();
if (!browser) { console.log('– skipped: Chrome が無い'); process.exit(0); }

const dir = await mkdtemp(join(tmpdir(), 'kjp-pair-check-'));
const repo = join(dir, 'repo');
const g = a => new Promise(r => spawn('git', a, { cwd: repo, stdio: 'ignore' }).on('close', r));
await import('node:fs/promises').then(m => m.mkdir(repo, { recursive: true }));
await g(['init', '-q', '-b', 'main']);
await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8');
await g(['add', '-A']);
await g(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const TOKEN = 'pair-probe-exec-token-0123456789';
const server = spawn(process.execPath, [join(ROOT, 'v0', 'server.mjs'),
    '--repo', repo, '--port', '0', '--allow-exec', '--token', TOKEN,
    // ⚠️ `--require-auth` が無いと登録の経路は閉じてある（壁が無いなら鍵を配る意味が無い）
    '--require-auth', '--devices-file', join(dir, 'devices.json')],
{ shell: false, windowsHide: true });
server.stdout.setEncoding('utf8');
let sout = '';
const base = await new Promise((res, rej) => {
    setTimeout(() => rej(new Error(`起動しない: ${sout}`)), 20000);
    server.stdout.on('data', d => {
        sout += d;
        const m = sout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) res(m[0]);
    });
});

const problems = [];

/**
 * 🚨 **再読込を跨ぐ待ちは `waitFor` では書けない。**
 *
 * 登録に成功すると `location.reload()` が走るので、その間の `evaluate` は
 * 「Inspected target navigated or closed」で**例外になる**（`waitFor` は素通しするので落ちる）。
 * さらに、古いページはまだ描画済みなので「ペインがある」は**再読込の前に満たされてしまう**
 * — 実測で、そのせいで再読込前の状態（`実行有効（トークン未取得）`）を読んで
 * 「登録できていない」と**誤診断した**。なので:
 *   1. 押す前に `window` に印を付け、
 *   2. **印が消えたこと**（= 別の document になった）を再読込の合図にする。
 */
async function afterReload(expr, ok, tries = 80, gapMs = 250) {
    let last = null;
    for (let i = 0; i < tries; i += 1) {
        // 遷移中の例外は「まだ」なので飲む（本物の失敗は下の ok で判定する）
        last = await evaluateSafe(expr);
        if (last !== undefined && ok(last)) return last;
        await new Promise(r => setTimeout(r, gapMs));
    }
    return last;
}
// 🔑 スマホが受け取るのは**読み取りの鍵つき URL**（実行の鍵は貼らない。これが要件）
const page = await openPage(`${base}/?token=${encodeURIComponent(readSecretOf(TOKEN))}`, { browser });
const { evaluate } = page;
const evaluateSafe = expr => evaluate(expr).then(v => v, () => undefined);

try {
    await waitFor(evaluate, "document.querySelectorAll('[data-pane-id]').length", n => n >= 1);

    // ---- 0. 前提: 読み取りの鍵だけなので実行はできない ----
    const before = await evaluate(`(() => ({
      cap: document.getElementById('cap')?.textContent ?? '',
      stored: localStorage.getItem('kjp.device'),
      pairBtn: [...document.querySelectorAll('button')].filter(b => b.textContent === 'この端末を登録').length,
    }))()`);
    if (before.pairBtn !== 1) {
        problems.push(`「この端末を登録」のボタンが ${before.pairBtn} 個（検査が対象を描けていない）`);
    }
    if (before.stored) problems.push('検査の前から端末の鍵が入っている（測っていない）');
    if (/実行有効(?!（)/.test(before.cap)) {
        problems.push(`承認前から実行できると表示している: ${before.cap}`);
    }

    // ---- 1. UI から登録を要求する（合言葉は画面に出ないことも測る） ----
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'この端末を登録').click()");
    await waitFor(evaluate,
        "document.querySelector('input[placeholder^=\"母艦に出た合言葉\"]')?.closest('.cmdbar')?.hidden === false",
        v => v === true);
    const code = (await readFile(join(dir, 'pair-code'), 'utf8')).trim();
    if (!/^[23456789A-HJ-NP-TV-Z]{4}-[23456789A-HJ-NP-TV-Z]{4}$/.test(code)) {
        problems.push(`母艦に合言葉が出ていない: ${JSON.stringify(code)}`);
    }
    // 🔒 **合言葉が画面のどこにも出ていない**（案内文に混ぜていない）
    const onScreen = await evaluate('document.body.innerText');
    if (code && onScreen.includes(code)) {
        problems.push('🚨 合言葉が端末の画面に出ている（母艦を読めない相手が承認できる）');
    }

    // ---- 2. 合言葉を入れて登録する ----
    // ⚠️ `input.value = …` では `input` イベントが飛ばない（CLAUDE.md のブラウザ規則6）。
    //    ここは値を読むだけの実装だが、**将来 input を見る実装に変えても壊れない**ように撃つ。
    await evaluate(`(() => {
      window.__beforeReload = 1;   /* 再読込を跨いだかの印（上の afterReload） */
      const i = document.querySelector('input[placeholder^="母艦に出た合言葉"]');
      i.value = ${JSON.stringify(code)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find(b => b.textContent === '登録する').click();
    })()`);

    // 登録に成功すると `location.reload()` が走る。**印が消えた**ことで跨いだと判定する
    const after = await afterReload(`(() => ({
      reloaded: typeof window.__beforeReload === 'undefined',
      panes: document.querySelectorAll('[data-pane-id]').length,
      cap: document.getElementById('cap')?.textContent ?? '',
      stored: (localStorage.getItem('kjp.device') || '').length,
      read: (sessionStorage.getItem('kjp_url') || '').length,
      pasted: (sessionStorage.getItem('kjp_token') || '').length,
      msgs: [...document.querySelectorAll('.wrmsg')].map(e => e.textContent).join(' | '),
    }))()`, v => v.reloaded && v.panes >= 1);

    console.log('登録のあと:', JSON.stringify(after));
    if (!after?.reloaded) {
        // ⚠️ **理由を画面から拾って出す。** 「登録できていない」だけでは
        //    合言葉が違ったのか配線が切れたのか分からない
        problems.push(`登録が完了しない（再読込が起きていない）: ${after?.msgs ?? '(読めない)'}`);
    }
    if (!after?.stored) {
        problems.push(`端末の鍵が localStorage に入っていない: ${after?.msgs ?? '(読めない)'}`);
    }
    // 🚨 ここが実際に壊れていた形。**「実行有効」だけで「（トークン未取得）」が付かない**
    if (!after?.cap?.includes('実行有効') || after.cap.includes('未取得')) {
        problems.push('🚨 承認したのに capability の表示が使えないまま'
            + `（読み取り秘密が端末の鍵より優先されている疑い）: ${after.cap}`);
    }
    // 🔒 端末の鍵を Cookie に入れない（ポートで分離されないので他のローカルページに渡る）
    const cookie = await evaluate('document.cookie');
    const secret = await evaluate("localStorage.getItem('kjp.device')");
    if (secret && cookie.includes(secret)) {
        problems.push('🚨 端末の鍵が Cookie に入っている');
    }

    // ---- 3. 貼らずに実行できる（要件そのもの） ----
    const ran = await evaluate(`(async () => {
      const r = await fetch('/api/v0/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          'x-kjp-token': localStorage.getItem('kjp.device') },
        body: JSON.stringify({ worktree: ${JSON.stringify(repo)}, argv: ['git', '--version'] }),
      });
      const t = await r.text();
      return { code: r.status, out: t.slice(0, 200) };
    })()`);
    if (ran.code !== 200) {
        problems.push(`承認した端末で実行が通らない: ${ran.code} ${ran.out}`);
    }

    // ---- 4. 失効させたら実行できなくなるが、読み取りは続き、嘘を言わない ----
    // 🔒 **測って前提を1つ捨てた（2026-08-18）。** 「死んだ鍵を握ると読み取りまで塞ぐ」と
    //    考えて `shouldForgetDevice` を書いたが、実測では**読み取りは Cookie で続く**
    //    （案内 URL を開いた時点で読み取り専用の派生秘密が Cookie に入っている）。
    //    なので塞がるのは実行だけ。ここで測るのは「**実行できないことを画面が言う**」で、
    //    それが**この repo が最悪とする誤り**（止めたつもりで動いている／
    //    使えるつもりで必ず 403）の反対側にあたる。
    //    ⚠️ 実行を取り戻す道も塞いでいない: 鍵つき URL を開き直せば
    //    `urlToken` が最優先なので通る（判定は devicekey.mjs のテスト）。
    const listed = await (await fetch(`${base}/api/v0/pair/list`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json', 'x-kjp-token': TOKEN,
            'sec-fetch-site': 'same-origin',
        },
        body: '{}',
    })).json();
    const target = listed.devices.find(d => !d.revokedAt);
    await fetch(`${base}/api/v0/pair/revoke`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json', 'x-kjp-token': TOKEN,
            'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ id: target.id }),
    });
    await evaluate('window.__beforeReload = 1; location.reload();')
        .catch(() => { /* 遷移で実行コンテキストが消えるのは正常 */ });
    const revoked = await afterReload(`(async () => {
      const r = await fetch('/api/v0/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          'x-kjp-token': localStorage.getItem('kjp.device') ?? '' },
        body: JSON.stringify({ worktree: ${JSON.stringify(repo)}, argv: ['git', '--version'] }),
      });
      void await r.text();
      return {
        reloaded: typeof window.__beforeReload === 'undefined',
        panes: document.querySelectorAll('[data-pane-id]').length,
        cap: document.getElementById('cap')?.textContent ?? '',
        execCode: r.status,
      };
    })()`, v => v.reloaded && v.panes >= 1);
    console.log('失効のあと:', JSON.stringify(revoked));
    if (!revoked?.panes) {
        problems.push('失効の後に画面が描けていない（実行を切ったら読み取りまで切れている）');
    }
    if (revoked?.execCode === 200) {
        problems.push('🚨 失効させた端末でまだ実行できる');
    }
    // 🚨 **「使えるつもりで必ず 403」を作らない。** 実行できないなら画面がそう言う
    if (revoked?.cap?.includes('実行有効') && !revoked.cap.includes('未取得')) {
        problems.push(`実行できないのに「実行有効」と表示している: ${revoked.cap}`);
    }
} catch (e) {
    problems.push(`検査そのものが落ちた: ${e.message}`);
}

if (problems.length) {
    console.log('');
    console.log('✖ pair');
    for (const t of problems) console.log(`   ${t}`);
    process.exitCode = 1;
} else console.log('✔ pair');

await page.close();
server.kill();
await rm(dir, { recursive: true, force: true }).catch(() => {});

// 🚨 `process.exit(0)` で終わらせない（引数が exitCode を上書きして**落ちない検査**になる）。
//    閉じかけのハンドルで Windows の libuv が異常終了するのを避けるため、
//    exitCode を保ったまま、イベントループが自然に終わらないときだけ発火させる。
const bail = setTimeout(() => process.exit(process.exitCode ?? 0), 5000);
bail.unref();
