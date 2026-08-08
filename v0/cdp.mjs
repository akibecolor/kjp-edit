// SPDX-License-Identifier: MIT
//
// 実ブラウザ検査の定型（Chrome を起こす → CDP に繋ぐ → 評価する → 後始末）。
//
// ⚠️ 依存ゼロ: Node 22+ の global WebSocket を使う（Playwright は入れない）。
// 🚨 **写さずにここへ集める。** #63 で「守りを書き写した瞬間に、それを測っていた
//    変異が『2箇所に一致する』で外れた」を踏んだばかり。検査の定型も同じで、
//    2本目の検査に貼り付けると片方だけ直る形の壊れ方をする。

import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
];

/** 使える Chrome を探す。無ければ null（呼ぶ側が skip を告げる） */
export async function findChrome() {
    for (const c of CHROME) {
        try { await access(c); return c; } catch { /* 次 */ }
    }
    return null;
}

/**
 * 空きポートを取る。
 *
 * ⚠️ **固定ポートにしない。** 他の検査やデーモンと同時に走ると衝突して
 *    「CDP に繋がらない」で落ちる（原因が分かりにくい形の flake になる）。
 */
export function freePort() {
    return new Promise((res, rej) => {
        const srv = createServer();
        srv.on('error', rej);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => res(port));
        });
    });
}

/**
 * Chrome を起こして CDP に繋ぐ。
 *
 * @param {string} url 開くアドレス
 * @param {{browser: string, windowSize?: string}} opts
 * @returns {Promise<{evaluate, cmd, close}>}
 *   evaluate(expr) は `returnByValue` で値を返す（例外は throw）。
 *   close() は WebSocket と Chrome とプロファイルを片付ける。
 */
export async function openPage(url, { browser, windowSize = '1280,900' }) {
    const profile = await mkdtemp(join(tmpdir(), 'kjp-cdp-'));
    const port = await freePort();
    const chrome = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
        `--window-size=${windowSize}`, url,
    ], { shell: false, windowsHide: true });

    const wsUrl = await (async () => {
        for (let i = 0; i < 60; i++) {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/json/list`);
                const list = await r.json();
                const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
                if (page) return page.webSocketDebuggerUrl;
            } catch { /* まだ立っていない */ }
            await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('CDP に繋がらない');
    })();

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = e => rej(new Error(`ws: ${e.message}`));
    });
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
        if (r.exceptionDetails) {
            throw new Error(`評価で例外: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
        }
        return r.result?.value;
    };
    await cmd('Runtime.enable');

    const close = async () => {
        try { ws.close(); } catch { /* noop */ }
        chrome.kill();
        await new Promise(r => setTimeout(r, 600));
        await rm(profile, { recursive: true, force: true }).catch(() => {});
    };
    return { evaluate, cmd, close };
}

/**
 * 条件が満たされるまで評価を繰り返す。
 *
 * ⚠️ **固定時間で待たない**（CLAUDE.md のブラウザ規則4）。
 *    描画は fetch を待つので、処理を足すと固定待ちが足りなくなる。
 */
export async function waitFor(evaluate, expr, ok, tries = 80, gapMs = 250) {
    let last = null;
    for (let i = 0; i < tries; i++) {
        last = await evaluate(expr);
        if (ok(last)) return last;
        await new Promise(r => setTimeout(r, gapMs));
    }
    return last;
}
