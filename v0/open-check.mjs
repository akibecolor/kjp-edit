// SPDX-License-Identifier: MIT
//
// 📁 **「開く」（プロジェクトの追加）を実ブラウザで通す検査**（`docs/open-project.md`）。
//
// 🚨 **なぜ実ブラウザで測るのか。** 経路の認可は smoke（HTTP）で固定してあるが、
//    「打った値が実際に送られるか」「足した後にセレクトが更新されて**切り替えられるか**」は
//    `app.html` の配線なので、字面の assert では
//    **行を残して到達不能にする変更**が完全に見えない（`docs/review-5-6-parallel.md`）。
//    足せても切り替えられなければ「開いた意味が無い」ので、そこまで通して測る。
// ⚠️ `input.value = …` は `input` イベントを飛ばさないので dispatchEvent で撃つ（CLAUDE.md）。
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, openPage, waitFor } from './cdp.mjs';

// ⚠️ 絶対パスを埋めない（他の環境で動かない）
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browser = await findChrome();
if (!browser) { console.log('– skipped: Chrome が無い'); process.exit(0); }

const mk = async name => {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), `kjp-oui-${name}-`));
    const r = join(dir, 'proj');
    await mkdir(r, { recursive: true });
    const g = a => new Promise(res => spawn('git', a, { cwd: r, stdio: 'ignore' }).on('close', res));
    await g(['init', '-q', '-b', 'main']);
    await writeFile(join(r, `${name}.txt`), 'x\n', 'utf8');
    await g(['add', '-A']);
    await g(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', name]);
    return { dir, path: r };
};
const base0 = await mk('base');
const extra = await mk('extra');

const TOKEN = 'open-ui-token-0123456789abcdef';
const server = spawn(process.execPath, [join(ROOT, 'v0', 'server.mjs'),
    '--repo', base0.path, '--port', '0', '--allow-exec', '--token', TOKEN],
{ shell: false, windowsHide: true });
server.stdout.setEncoding('utf8');
let sout = '';
const url = await new Promise((res, rej) => {
    setTimeout(() => rej(new Error(`起動しない: ${sout}`)), 20000);
    server.stdout.on('data', d => {
        sout += d;
        const m = sout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) res(m[0]);
    });
});

const problems = [];
const page = await openPage(`${url}/?token=${TOKEN}`, { browser });
const { evaluate } = page;
// 遷移中の評価は例外になるので飲む（本物の失敗は下の判定で見る）
const safe = e => evaluate(e).then(v => v, () => undefined);

try {
    await waitFor(evaluate, "document.querySelectorAll('[data-pane-id]').length", n => n >= 1);
    const before = await evaluate(`(() => ({
      btn: !document.getElementById('openproj').hidden,
      barHidden: document.getElementById('openbar').hidden,
      sel: !document.getElementById('reposel').hidden,
    }))()`);
    console.log('初期:', JSON.stringify(before));
    if (!before.btn) problems.push('「開く」ボタンが出ていない（実行の鍵があるのに）');
    if (!before.barHidden) problems.push('押す前から入力欄が出ている');
    if (before.sel) problems.push('1本しか登録が無いのにセレクトが出ている');

    await evaluate("document.getElementById('openproj').click()");
    const opened = await evaluate(`(() => {
      const i = document.querySelector('#openbar input');
      return { bar: !document.getElementById('openbar').hidden, input: !!i };
    })()`);
    if (!opened.bar || !opened.input) problems.push(`入力欄が出ない: ${JSON.stringify(opened)}`);

    await evaluate(`(() => {
      window.__before = 1;   /* 再読込を跨いだかの印 */
      const i = document.querySelector('#openbar input');
      i.value = ${JSON.stringify(extra.path.split(sep).join('/'))};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#openbar button')].find(b => b.textContent === '足す').click();
    })()`);

    // 足すと再読込が走る。**印が消えたこと**で跨いだと判定する（古い画面を読んで誤診断しない）
    let after = null;
    for (let i = 0; i < 80; i += 1) {
        after = await safe(`(() => ({
          reloaded: typeof window.__before === 'undefined',
          panes: document.querySelectorAll('[data-pane-id]').length,
          sel: !document.getElementById('reposel').hidden,
          opts: [...document.getElementById('reposel').options].map(o => o.value),
          msg: [...document.querySelectorAll('#openbar .wrmsg')].map(e => e.textContent).join(' | '),
        }))()`);
        if (after?.reloaded && after.panes >= 1) break;
        await new Promise(r => setTimeout(r, 250));
    }
    console.log('足した後:', JSON.stringify(after));
    if (!after?.reloaded) problems.push(`足しても再読込されない（失敗した？）: ${after?.msg}`);
    if (!after?.sel) problems.push('2本になったのにセレクトが出ていない（切り替えられない）');
    if (!(after?.opts ?? []).some(v => v.toLowerCase().includes('extra'))) {
        problems.push(`足したリポジトリがセレクトに無い: ${JSON.stringify(after?.opts)}`);
    }

    // 🚨 足した意味があること = **切り替えたら対象が変わる**（ここまで見ないと足し損）
    const sw = await evaluate(`(async () => {
      const sel = document.getElementById('reposel');
      const opt = [...sel.options].find(o => o.value.toLowerCase().includes('extra'));
      if (!opt) return { error: 'extra の option が無い', opts: [...sel.options].map(o => o.value) };
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (document.getElementById('repo').textContent.toLowerCase().includes('extra')) break;
      }
      return { repo: document.getElementById('repo').textContent };
    })()`);
    console.log('切り替え:', JSON.stringify(sw));
    if (sw.error) problems.push(sw.error);
    else if (!String(sw.repo).toLowerCase().includes('extra')) {
        problems.push(`切り替えても対象が変わらない: ${sw.repo}`);
    }
} catch (e) {
    problems.push(`検査そのものが落ちた: ${e.message}`);
}

if (problems.length) {
    console.log('');
    console.log('✖ open');
    for (const t of problems) console.log(`   ${t}`);
    process.exitCode = 1;
} else console.log('✔ open');

await page.close();
server.kill();
await rm(base0.dir, { recursive: true, force: true }).catch(() => {});
await rm(extra.dir, { recursive: true, force: true }).catch(() => {});

// 🚨 `process.exit(0)` で終わらせない（引数が exitCode を上書きして**落ちない検査**になる）
const bail = setTimeout(() => process.exit(process.exitCode ?? 0), 5000);
bail.unref();
