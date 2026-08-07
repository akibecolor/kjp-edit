// #58 の手段でグリッドのドラッグを測る（CDP の Input ドメイン = **入力層に流す**）。
// 合成イベント（dispatchEvent）ではないので、click の生成・テキスト選択・
// ヒットテスト・ポインタキャプチャが**実機と同じ**に働く。
//
// ⚠️ 依存ゼロ: Node 22+ の global WebSocket を使う（Playwright は入れない）。
// ⚠️ iframe を挟まない（ページを直接開く）。座標計算を単純にするため。
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
// ⚠️ 絶対パスを埋めない（他の環境で動かない）
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CH = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
let browser = null;
for (const c of CH) { try { await access(c); browser = c; break; } catch { /* 次 */ } }
if (!browser) { console.log('– skipped: Chrome が無い'); process.exit(0); }

const repo = await mkdtemp(join(tmpdir(), 'kjp-input-'));
const g = a => new Promise(r => spawn('git', a, { cwd: repo, stdio: 'ignore' }).on('close', r));
await g(['init', '-q', '-b', 'main']);
await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8');
await g(['add', '-A']);
await g(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const TOKEN = 'input-probe-token-0123456789';
const server = spawn(process.execPath, [join(ROOT, 'v0', 'server.mjs'),
    '--repo', repo, '--port', '0', '--allow-exec', '--token', TOKEN],
{ shell: false, windowsHide: true });
server.stdout.setEncoding('utf8');
let sout = '';
const base = await new Promise((res, rej) => {
    setTimeout(() => rej(new Error('起動しない: ' + sout)), 20000);
    server.stdout.on('data', d => {
        sout += d;
        const m = sout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) res(m[0]);
    });
});

const profile = await mkdtemp(join(tmpdir(), 'kjp-input-prof-'));
const PORT = 9333;
const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1280,900',
    `${base}/?grid=1&probe=1&token=${TOKEN}`,
], { shell: false, windowsHide: true });

/** CDP に繋ぐ（ターゲットが出るまで待つ） */
const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const list = await r.json();
            const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* まだ立っていない */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('CDP に繋がらない');
})();

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws: ' + e.message)); });
let id = 0;
const pending = new Map();
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async expr => {
    const r = await cmd('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('評価で例外: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
};

await cmd('Runtime.enable');
// 描画が済むまで待つ（固定時間で待たない）
for (let i = 0; i < 80; i++) {
    const n = await evaluate("document.querySelectorAll('[data-pane-id]').length");
    if (n >= 3) break;
    await new Promise(r => setTimeout(r, 250));
}

const before = await evaluate(`(() => {
  const ps = [...document.querySelectorAll('.pane')];
  const p = ps[0];
  const h = p.querySelector('header');
  const shell = document.getElementById('shell');
  const sr = shell.getBoundingClientRect();
  const hr = h.getBoundingClientRect();
  const cols = Number(getComputedStyle(shell).gridTemplateColumns.split(' ').length);
  const rows = Number(getComputedStyle(shell).gridTemplateRows.split(' ').length);
  return {
    id: p.dataset.paneId, style: p.style.gridColumn + ' / ' + p.style.gridRow,
    grab: { x: Math.round(hr.left + 40), y: Math.round(hr.top + hr.height / 2) },
    drop: { x: Math.round(sr.left + sr.width * 0.5 + 20), y: Math.round(sr.top + sr.height * 0.75) },
    cols, rows, panes: ps.length,
    selection: String(document.getSelection() || ''),
  };
})()`);
console.log('掴む前:', JSON.stringify(before));

/** 実際のマウスとして流す（入力層を通る = 選択もキャプチャも実機と同じ） */
const mouse = (type, x, y, extra = {}) => cmd('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, ...extra,
});
await mouse('mousePressed', before.grab.x, before.grab.y);
// 少しずつ動かす（しきい値 6px を越え、途中の pointermove も届く）
const steps = 8;
for (let i = 1; i <= steps; i++) {
    const x = before.grab.x + (before.drop.x - before.grab.x) * (i / steps);
    const y = before.grab.y + (before.drop.y - before.grab.y) * (i / steps);
    await mouse('mouseMoved', Math.round(x), Math.round(y));
    await new Promise(r => setTimeout(r, 30));
}
await mouse('mouseReleased', before.drop.x, before.drop.y);
await new Promise(r => setTimeout(r, 600));

const after = await evaluate(`(() => {
  const p = document.querySelector('[data-pane-id=' + JSON.stringify(${JSON.stringify(before.id)}) + ']');
  const bar = document.getElementById('gridbar');
  return {
    style: p ? p.style.gridColumn + ' / ' + p.style.gridRow : '(ペインが無い)',
    selection: String(document.getSelection() || '').slice(0, 40),
    note: (bar?.textContent || '').slice(-90),
  };
})()`);
console.log('離した後:', JSON.stringify(after));
const pg = await evaluate("typeof window.__kjpGrid === 'function' ? window.__kjpGrid() : null");
console.log('配置:', pg ? JSON.stringify(pg.cells) : '(覗けない)');
const tc = await evaluate(`(() => {
  const shell = document.getElementById('shell');
  const r = shell.getBoundingClientRect();
  const cols = ${before.cols}, rows = ${before.rows};
  const col = Math.min(cols, Math.max(1, Math.floor((${before.drop.x} - r.left) / (r.width / cols)) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((${before.drop.y} - r.top) / (r.height / rows)) + 1));
  return { col, row, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
})()`);
console.log('落とし先のセル:', JSON.stringify(tc));
console.log('');
console.log('判定:');
console.log('  座標が変わったか:', before.style !== after.style ? '✔ 動いた' : '✖ 動いていない');
console.log('  文字選択が起きたか:', after.selection ? `✖ 選択された（${after.selection}）` : '✔ 選択なし');
console.log('  グリッド:', before.cols + '列 × ' + before.rows + '行 / ペイン ' + before.panes + '枚');

// 🚨 **落ちる検査にする。** 出力を眺めるだけでは回帰を止められない。
const problems = [];
if (before.style === after.style) problems.push('掴んで動かしてもセルが変わらない（#57 の移動）');
if (after.selection) problems.push('ヘッダのドラッグが文字選択になっている: ' + after.selection);
if (problems.length) {
    console.log('');
    console.log('✖ input');
    for (const t of problems) console.log('   ' + t);
    process.exitCode = 1;
} else console.log('✔ input');

try { ws.close(); } catch { /* noop */ }
chrome.kill();
server.kill();
await new Promise(r => setTimeout(r, 600));
await rm(profile, { recursive: true, force: true }).catch(() => {});
await rm(repo, { recursive: true, force: true }).catch(() => {});
process.exit(0);
