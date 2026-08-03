// SPDX-License-Identifier: MIT
//
// エージェントの活動記録（Claude Code のセッション記録）から**要約だけ**を作る。
//
//   ~/.claude/projects/<slug>/<sessionId>.jsonl
//
// 設計と判断の経緯は docs/agent-observation.md。ここでは実装上の要点だけ書く。
//
// 🚨 **この経路は「出してはいけないものを出さない」ことが本体。**
//    記録には会話の全文・読んだファイルの中身・コマンドの出力が入っている。
//    トンネル越しに繋がる相手へ全部渡さないために、**許可リスト方式**にする。
//    「これを除く」ではなく「これだけ入れる」。
//
// ⚠️ 除外方式が成立しない理由は実測で確認した（2026-08-03）。
//    ツールの結果は**入口が複数ある**:
//      - message.content[].type === 'tool_result'
//      - トップレベルの toolUseResult（{stdout, stderr, ...}）
//      - type === 'file-history-snapshot' の snapshot（ファイルの中身）
//      - type === 'file-history-delta' の backup
//      - type === 'attachment' の attachment
//    さらに自由文は message の外にもある（last-prompt.lastPrompt /
//    custom-title.customTitle / queue-operation.content）。
//    形式は Claude Code の内部形式で公開 API ではないので**フィールドは増える**。
//    除外方式だと増えた瞬間に黙って漏れる。許可リストなら表示が減るだけで済む。

import { readdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { containsPath, relativeInside, isSafeRepoPath } from './git.mjs';

export const LIMITS = {
    tailBytes: 256 * 1024,   // 末尾だけ読む（実測で 24MB の記録があった）
    headBytes: 16 * 1024,    // cwd を知るために先頭だけ読む
    maxLines: 600,           // 走査する行数の上限
    maxDirs: 60,             // projects 配下を見る上限
    maxRecent: 12,           // 出す活動の件数
    maxText: 8,              // 出す発話の件数
    textChars: 400,          // 1件あたりの文字数
    commandChars: 300,
    activeMs: 3 * 60 * 1000,
    idleMs: 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// 許可リスト
// ---------------------------------------------------------------------------

/** 走査するレコード種別。**ここに無い type は1バイトも見ない。** */
const SCAN_TYPES = new Set(['assistant', 'user', 'mode', 'permission-mode']);

/** ツール入力のうち「パス」として扱うキー。これ以外の入力は見ない。 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

/** コマンド行を持つツール（自由文なので --allow-transcript-text が必要） */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * 列挙値として通す文字列。
 *
 * ⚠️ `mode` や `permissionMode` を**そのまま**払い出してはいけない。
 *    記録の中の文字列なので、形式が変われば任意の長さの文字列が来うる。
 *    「列挙可能な値だけ出す」を文字どおり成立させるために形を縛る。
 */
function enumValue(v, max = 32) {
    return typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;
}

/** ツール名。記録由来なので同じく形を縛る。 */
function toolName(v) {
    return typeof v === 'string' && v.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;
}

/**
 * ISO8601 として妥当な timestamp だけ通す（自由文が紛れ込む余地を消す）。
 *
 * 🚨 **`Date.parse` を検証に使ってはいけない。** V8 の緩いフォールバック解析は
 *    `INJECT-SECRET-12345` を**西暦 12345 年**として受け入れて 327403350000000 を返す
 *    （実測）。それを妥当と見なすと、timestamp が自由文の抜け道になる。
 *    先に形を正規表現で縛る。
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function isoTime(v) {
    if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
    return Number.isFinite(Date.parse(v)) ? v : null;
}

/** 自由文を切り詰める。**allowText のときだけ呼ぶ。** */
function clip(v, max) {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 絶対パスを worktree 相対に丸める。
 *
 * ⚠️ リポジトリの外を触っていた場合は**パスを出さない**。
 *    記録には他プロジェクトのパスも入る。
 */
export function repoRelative(base, abs) {
    if (typeof abs !== 'string' || !abs || typeof base !== 'string') return null;
    // ⚠️ path.relative() を使わない。記録の中のパスは worktree のパスと
    //    表記が違いうる（8.3 短縮名 / symlink / 大文字小文字）。
    //    素の relative() だと `../../..` になって、中にあるファイルなのに
    //    「外」と判定される（漏れではなく**見失う**方向の壊れ方）
    const rel = relativeInside(base, abs);
    if (rel === null || rel === '') return null;
    // isSafeRepoPath は HTTP から来た値と同じ検証。ここも通す（UI が
    // このパスで差分を開くので、開ける形であることを保証する）
    return isSafeRepoPath(rel) ? rel : null;
}

// ---------------------------------------------------------------------------
// 要約（純関数。fs を触らないので単体でテストできる）
// ---------------------------------------------------------------------------

/**
 * 記録の行（新しい順でなくてよい）から要約を作る。
 *
 * @param {string[]} lines JSON の行
 * @param {object} o
 * @param {string} o.worktreePath パスを相対化する基準
 * @param {boolean} [o.allowText] 自由文（発話・コマンド行）を出すか
 * @param {number} [o.now] 現在時刻（ms）。テストで固定するために注入できる
 */
export function summarize(lines, { worktreePath, allowText = false, now = Date.now(), limits = LIMITS } = {}) {
    const out = {
        session: null,
        lastActivityAt: null,
        ageMs: null,
        state: 'none',
        mode: null,
        permissionMode: null,
        toolCounts: {},
        recent: [],
        talk: 0,             // 発話の件数（本文は allowText のときだけ text に入る）
        text: [],
        sidechains: 0,
        scanned: 0,
        dropped: 0,
    };

    // 新しい順に見たいので後ろから。行数の上限で打ち切る。
    const from = Math.max(0, lines.length - limits.maxLines);
    const window = lines.slice(from);
    let newestTs = null;

    for (let i = window.length - 1; i >= 0; i--) {
        const raw = window[i];
        if (!raw || !raw.trim()) continue;
        let r;
        try { r = JSON.parse(raw); } catch { out.dropped++; continue; }
        if (!r || typeof r !== 'object') { out.dropped++; continue; }
        // 🚨 許可リスト。ここに無い type は中身を一切見ない
        //    （file-history-snapshot / attachment / last-prompt などが該当）
        if (!SCAN_TYPES.has(r.type)) continue;
        out.scanned++;

        if (r.type === 'mode') { out.mode ??= enumValue(r.mode); continue; }
        if (r.type === 'permission-mode') { out.permissionMode ??= enumValue(r.permissionMode); continue; }

        out.session ??= enumValue(r.sessionId, 64);
        const at = isoTime(r.timestamp);
        if (at && !newestTs) newestTs = at;
        if (r.isSidechain === true) out.sidechains++;

        const content = r.message?.content;
        if (!Array.isArray(content)) {
            // content が文字列のこともある（実測: user）。**本文は allowText でのみ出す。**
            if (typeof content === 'string' && r.type === 'user') {
                out.talk++;
                if (allowText && out.text.length < limits.maxText) {
                    const t = clip(content, limits.textChars);
                    if (t) out.text.push({ at, role: 'user', text: t });
                }
            }
            continue;
        }

        for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            // 🚨 tool_result と thinking は allowText でも出さない（T5）。
            //    ファイルの中身とコマンド出力が入るので、
            //    `git cat-file` 経由という不変条件を完全に無効化する
            if (b.type === 'tool_result' || b.type === 'thinking') continue;

            if (b.type === 'tool_use') {
                const name = toolName(b.name);
                if (!name) continue;
                out.toolCounts[name] = (out.toolCounts[name] ?? 0) + 1;
                if (out.recent.length >= limits.maxRecent) continue;
                const input = b.input && typeof b.input === 'object' ? b.input : {};
                let path = null;
                let outside = false;
                for (const k of PATH_KEYS) {
                    if (typeof input[k] !== 'string') continue;
                    path = repoRelative(worktreePath, input[k]);
                    outside = path === null;   // 触ってはいるが外
                    break;
                }
                const entry = { at, tool: name, path, outside, sidechain: r.isSidechain === true };
                // T2: コマンド行は自由文。既定では出さない
                if (allowText && COMMAND_TOOLS.has(name)) {
                    entry.command = clip(input.command, limits.commandChars);
                }
                out.recent.push(entry);
                continue;
            }

            if (b.type === 'text') {
                out.talk++;
                if (allowText && out.text.length < limits.maxText) {
                    const t = clip(b.text, limits.textChars);
                    if (t) out.text.push({ at, role: r.type === 'assistant' ? 'assistant' : 'user', text: t });
                }
            }
        }
    }

    out.lastActivityAt = newestTs;
    if (newestTs) {
        out.ageMs = Math.max(0, now - Date.parse(newestTs));
        out.state = out.ageMs <= limits.activeMs ? 'active'
            : out.ageMs <= limits.idleMs ? 'idle' : 'stale';
    }
    return out;
}

// ---------------------------------------------------------------------------
// 読み取り（fs のみ。git の spawn は増やさない）
// ---------------------------------------------------------------------------

/** ファイルの末尾 n バイトを行に分割して返す。先頭の不完全な行は捨てる。 */
export async function readTail(file, maxBytes = LIMITS.tailBytes) {
    const fh = await open(file, 'r');
    try {
        const { size } = await fh.stat();
        const len = Math.min(maxBytes, size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        // ⚠️ Buffer で受けて最後に一度だけデコードする。
        //    途中で toString すると3バイト文字を割る（CLAUDE.md）
        const lines = buf.toString('utf8').split('\n');
        // 末尾から読んだので、ファイル全体を読んでいない限り1行目は途中
        if (len < size) lines.shift();
        return { lines, bytes: len, truncated: len < size };
    } finally {
        await fh.close();
    }
}

/** 先頭 n バイトから cwd を拾う（どの worktree の記録かを知るためだけ） */
async function readCwd(file, maxBytes = LIMITS.headBytes) {
    const fh = await open(file, 'r');
    try {
        const { size } = await fh.stat();
        const len = Math.min(maxBytes, size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) lines.pop();   // 末尾の行は途中
        for (const l of lines) {
            if (!l.trim()) continue;
            let r;
            try { r = JSON.parse(l); } catch { continue; }
            if (typeof r?.cwd === 'string' && r.cwd) return r.cwd;
        }
        return null;
    } finally {
        await fh.close();
    }
}

/** projects 配下の既定の場所。**パスは組み立てず、ここを readdir する。** */
export function transcriptRoot() {
    return join(homedir(), '.claude', 'projects');
}

/**
 * worktree ごとの活動要約を集める。
 *
 * @param {{path: string, label: string}[]} worktrees
 * @returns {Promise<{agents: object[], errors: {scope: string, message: string}[]}>}
 */
export async function collectAgents(worktrees, {
    root = transcriptRoot(), allowText = false, now = Date.now(), limits = LIMITS,
} = {}) {
    const errors = [];
    const byPath = new Map();   // worktree path -> 要約
    let dirs;
    try {
        dirs = await readdir(root, { withFileTypes: true });
    } catch (e) {
        return {
            agents: [],
            errors: [{
                scope: 'agents',
                message: `活動記録の場所を読めません（${root}）: ${e.code ?? e.message}。`
                    + ' Claude Code を使っていないか、場所が違います。',
            }],
        };
    }

    let scannedDirs = 0;
    let skippedDirs = 0;
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        if (scannedDirs >= limits.maxDirs) { skippedDirs++; continue; }
        scannedDirs++;
        const dir = join(root, d.name);
        // そのディレクトリの中で最新の *.jsonl を1本だけ見る
        let newest = null;
        try {
            for (const f of await readdir(dir)) {
                if (!f.endsWith('.jsonl')) continue;   // ⚠️ それ以外は開かない
                const p = join(dir, f);
                const s = await stat(p);
                if (!s.isFile()) continue;
                if (!newest || s.mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs: s.mtimeMs };
            }
        } catch { continue; }
        if (!newest) continue;

        // まず cwd だけ拾い、担当の worktree が無ければ末尾は読まない（無駄な読み取りを避ける）
        let cwd = null;
        try { cwd = await readCwd(newest.path, limits.headBytes); } catch { continue; }
        if (!cwd) continue;
        // 最も深く一致する worktree を選ぶ（サブディレクトリで動かしている場合に対応）
        let owner = null;
        for (const w of worktrees) {
            if (!containsPath(w.path, cwd)) continue;
            if (!owner || w.path.length > owner.path.length) owner = w;
        }
        if (!owner) continue;   // 他プロジェクトの記録。無視する（エラーではない）

        let tail;
        try { tail = await readTail(newest.path, limits.tailBytes); } catch { continue; }
        const s = summarize(tail.lines, { worktreePath: owner.path, allowText, now, limits });
        s.bytesRead = tail.bytes;
        s.tailOnly = tail.truncated;
        const prev = byPath.get(owner.path);
        // 同じ worktree に複数の記録が対応することがある（slug の大文字小文字違い）。
        // 新しい方を採る
        if (!prev || (s.lastActivityAt ?? '') > (prev.lastActivityAt ?? '')) {
            byPath.set(owner.path, s);
        }
    }

    if (skippedDirs) {
        // 表示上限で省略したら必ず告知する（CLAUDE.md）
        errors.push({
            scope: 'agents',
            message: `活動記録は ${limits.maxDirs} 個のプロジェクトで打ち切りました（${skippedDirs} 個未確認）。`,
        });
    }

    const agents = worktrees.map(w => ({
        path: w.path,
        name: w.label,
        ...(byPath.get(w.path) ?? { state: 'none', session: null, lastActivityAt: null, ageMs: null }),
    }));
    return { agents, errors };
}
