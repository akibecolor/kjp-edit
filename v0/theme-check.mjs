// 配色（ダーク / ライト）が**実際に当たっていて読めること**を実ブラウザで測る。
//
// 🚨 **値の下限は unit（`theme.test.mjs`）で固定してある。ここが測るのは別のこと**:
//    「CSS がその値を当てているか」。`data-theme` を書き忘れる／変数を使い忘れる形は
//    unit では1件も捕まらない（実際、差分ビューだけ直値のままだった）。
// ⚠️ 依存ゼロ。CDP の定型は `v0/cdp.mjs`（input-check と共有）。

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, openPage, waitFor } from './cdp.mjs';
import { contrastRatio, MIN_CONTRAST } from './theme.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browser = await findChrome();
if (!browser) { console.log('– skipped: Chrome が無い'); process.exit(0); }

// 使い捨てのリポジトリ（差分の行を出したいので、変更を1つ作る）
const repo = await mkdtemp(join(tmpdir(), 'kjp-theme-'));
const g = a => new Promise(r => spawn('git', a, { cwd: repo, stdio: 'ignore' }).on('close', r));
await g(['init', '-q', '-b', 'main']);
await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
await g(['add', '-A']);
await g(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const TOKEN = 'theme-probe-token-0123456789';
const server = spawn(process.execPath, [join(ROOT, 'v0', 'server.mjs'),
    '--repo', repo, '--port', '0', '--token', TOKEN],
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
const page = await openPage(`${base}/?token=${TOKEN}`, { browser });
try {
    // 描画が済むまで待つ（固定時間で待たない）
    await waitFor(page.evaluate,
        "document.querySelectorAll('[data-pane-id]').length", n => n >= 3);

    // 🚨 **ボタンが実在すること**（検査が対象を描けていることを検査自身が確かめる）
    const hasButton = await page.evaluate("!!document.getElementById('theme')");
    if (!hasButton) problems.push('配色のボタン（#theme）が描かれていない');

    /**
     * その配色を当てて、実際に描かれている色を読む。
     *
     * 🚨 **変数だけを読まない（変異 theme-diff-hardcoded が SURVIVED して分かった）。**
     *    `--add` が正しくても、`.diff .add` が直値なら**要素には当たっていない**。
     *    測るのは「利用者が見る色」なので、**要素の computed color** を読む。
     *    差分ペインが開いていなくても規則は測れるよう、同じ class の見本を挿す。
     */
    const read = async applied => page.evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(applied)};
      let probe = document.getElementById('__themeprobe');
      if (!probe) {
        probe = document.createElement('div');
        probe.id = '__themeprobe';
        probe.className = 'diff';
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        probe.innerHTML = '<div class="add">+a</div><div class="del">-d</div>';
        document.body.appendChild(probe);
      }
      const cs = getComputedStyle(document.documentElement);
      const v = n => cs.getPropertyValue(n).trim();
      const el = q => getComputedStyle(probe.querySelector(q)).color;
      return {
        theme: document.documentElement.dataset.theme,
        body: getComputedStyle(document.body).backgroundColor,
        bg: v('--bg'), fg: v('--fg'), dim: v('--dim'),
        warn: v('--warn'), ok: v('--ok'), danger: v('--danger'),
        accent: v('--accent'),
        // ⚠️ 要素に当たっている色（変数ではない）
        add: el('.add'), del: el('.del'),
      };
    })()`);

    const seen = {};
    for (const applied of ['light', 'dark']) {
        const c = await read(applied);
        seen[applied] = c;
        const need = k => (k === 'fg' ? MIN_CONTRAST.fg
            : k === 'dim' ? MIN_CONTRAST.dim : MIN_CONTRAST.state);
        for (const k of ['fg', 'dim', 'warn', 'ok', 'danger', 'accent', 'add', 'del']) {
            const r = contrastRatio(c[k], c.bg);
            // ⚠️ **測れなかったら失敗**（null を「十分」と読まない）
            if (r === null) {
                problems.push(`${applied}: --${k} を測れない（値: ${JSON.stringify(c[k])}）`);
                continue;
            }
            if (r < need(k)) {
                problems.push(`${applied}: --${k}（${c[k]}）のコントラストが `
                    + `${r.toFixed(2)} で下限 ${need(k)} 未満 = 読めない`);
            }
        }
        console.log(`${applied.padEnd(5)} bg=${c.bg} fg=${c.fg} `
            + `add=${c.add} del=${c.del} warn=${c.warn}`);
    }

    // 🚨 **当たっていること自体を測る**（両方が同じ色なら切り替わっていない）
    if (seen.light.body === seen.dark.body) {
        problems.push(`ライトとダークで body の背景が同じ（${seen.light.body}）`
            + ' = data-theme が効いていない');
    }
    // 🚨 **差分の色も配色で変わること。** ここが同じなら要素が直値
    //    （OS がダークのままライトを選ぶと差分だけ読めない、という実際の壊れ方）
    for (const k of ['add', 'del']) {
        if (seen.light[k] === seen.dark[k]) {
            problems.push(`差分の ${k} がライトとダークで同じ（${seen.light[k]}）`
                + ' = 要素に配色が当たっていない（直値のまま）');
        }
    }

    // 🚨 **選んだ配色が再読込で残ること**（覚えていないと毎回戻る）。
    //    ⚠️ **ボタンを押して測る。** `localStorage.setItem` を検査から直接呼ぶと
    //    「読む側」しか測れず、**保存を外した変異が生き残る**（実測で SURVIVED）。
    const clicked = await page.evaluate(`(() => {
      const b = document.getElementById('theme');
      if (!b) return null;
      // auto → light → dark → auto を巡るので、light になるまで押す（最大3回）
      for (let i = 0; i < 3; i++) {
        if ((document.documentElement.dataset.theme || 'auto') === 'light') break;
        b.click();
      }
      return document.documentElement.dataset.theme || '';
    })()`);
    if (clicked !== 'light') {
        problems.push(`ボタンでライトを選べない（data-theme=${JSON.stringify(clicked)}）`);
    }
    await page.evaluate('location.reload()');
    const kept = await waitFor(page.evaluate,
        "document.documentElement.dataset.theme || ''", v => v === 'light', 40, 250);
    if (kept !== 'light') {
        problems.push(`再読込で選んだ配色が残らない（data-theme=${JSON.stringify(kept)}）`);
    }
} finally {
    await page.close();
    server.kill();
    await rm(repo, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (problems.length) {
    console.log('✖ theme');
    for (const t of problems) console.log(`   ${t}`);
    process.exitCode = 1;
} else console.log('✔ theme');

// ⚠️ `process.exit(0)` で終わらせない（引数が exitCode を上書きする。#58 で踏んだ）。
//    イベントループが自然に終わらないときだけ発火する保険にする。
const bail = setTimeout(() => process.exit(process.exitCode ?? 0), 5000);
bail.unref();
