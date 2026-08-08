// SPDX-License-Identifier: MIT
//
// Claude Code の `PreToolUse` フック（#59）。
// **編集を始める前に**「他のエージェントの worktree と衝突しないか」を
// 動いているデーモンに問い合わせ、衝突していたら止める。
//
// 使い方（`.claude/settings.json`）:
//   {"hooks": {"PreToolUse": [{"matcher": "Edit|Write|MultiEdit|NotebookEdit",
//     "hooks": [{"type": "command",
//       "command": "node scripts/precheck.mjs"}]}]}}
//
// 🔒 **読み取りだけ。** 使うのは `~/.kjp-edit/token-read` で、
//    `token-exec` / `token-write` には触らない（capability の分界を跨がない）。
// 🚨 **デーモンが動いていないときに「衝突なし」と答えない。**
//    判定できない場合は `ask`（人間に聞く）。判定の本体は
//    `v0/precheck.mjs` の純関数で、`v0/precheck.test.mjs` が固定している。
//
// 終了コードは常に 0（フック自身の失敗で編集を止めない）。判定は stdout の JSON で返す。

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, dirname, isAbsolute } from 'node:path';
import { decide, touchedPaths, ALLOW } from '../v0/precheck.mjs';

const STATE = join(homedir(), '.kjp-edit');
const TIMEOUT_MS = 5000;

/** stdin を読む（フックの入力は JSON 1件） */
async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

/** 判定を返して終わる。allow は黙って通す（フックの出力を汚さない） */
function reply(decision, reason) {
    if (decision === ALLOW) { process.exit(0); }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: `[kjp-edit] ${reason}`,
        },
    }));
    process.exit(0);
}

/**
 * git に1回だけ聞く（shell は使わない）。
 *
 * 🚨 **`--show-toplevel` だけでは足りない。** リンクされた worktree では
 *    toplevel は worktree のディレクトリで、**デーモンに登録されているリポジトリの
 *    パスではない**。`?repo=` は登録済み一覧との照合なので、worktree のパスを
 *    渡すと 400 になり、**エージェントが worktree で働いている本命の場合に
 *    毎回 ask になる**。`--git-common-dir` の親がメインの worktree（= 登録名）。
 */
function gitOut(cwd, args) {
    return new Promise(resolve => {
        const ch = spawn('git', ['-C', cwd, ...args], {
            shell: false, windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        });
        let out = '';
        ch.stdout.on('data', d => { out += d; });
        // 🚨 spawn の 'error' に listener を付ける（付けないと uncaught で即死する）
        ch.on('error', () => resolve(null));
        ch.on('close', code => resolve(code === 0 && out.trim() ? out.trim() : null));
    });
}

const raw = await readStdin();
let hook;
try { hook = JSON.parse(raw); } catch { reply('ask', '入力を解釈できませんでした。'); }

const paths = touchedPaths(hook.tool_name, hook.tool_input);
const first = paths?.[0];
const dir = first && isAbsolute(first) ? dirname(first) : (hook.cwd || process.cwd());
const root = await gitOut(dir, ['rev-parse', '--show-toplevel']);
if (!root) reply('ask', `git の worktree を特定できませんでした（${dir}）。`);
// `<main>/.git` → `<main>`（メインの worktree ならここでも同じ場所になる）
const common = await gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
const repoRoot = common ? dirname(common) : root;

let base, token;
try {
    const last = JSON.parse(await readFile(join(STATE, 'last.json'), 'utf8'));
    base = `http://127.0.0.1:${last.port}`;
    token = (await readFile(join(STATE, 'token-read'), 'utf8')).trim();
} catch (err) {
    reply('ask', `デーモンの接続先を読めませんでした（${err.message}）。起動していますか？`);
}

// リポジトリ相対に直す（API に渡すのは相対パス）
const rel = (paths ?? []).map(p => relative(root, p).split('\\').join('/'))
    .filter(p => p && !p.startsWith('..'));

let answer = null, error = null;
try {
    const res = await fetch(`${base}/api/v0/precheck?repo=${encodeURIComponent(repoRoot)}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-kjp-token': token,
            'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ worktree: root, paths: rel }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    else answer = await res.json();
} catch (err) {
    error = err.message;
}

// ⚠️ `?repo=` は「登録済みの表記」でしか通らない。別リポジトリで動かしたときは
//    400 になるが、それは **ask** であって allow ではない（上の error 経由）。
const r = decide({ answer, error, paths: rel });
reply(r.decision, r.reason);
