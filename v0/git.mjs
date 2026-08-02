// SPDX-License-Identifier: MIT
// git の起動は docs/encoding-and-paths.md の「正典のレシピ」に従う。
// - spawn(gitPath, argvArray) で shell は絶対に使わない
//   (injection と、日本語ファイル名が約85文字で落ちる msys2 NAME_MAX 問題を同時に回避)
// - パスを含むコマンドは -z (core.quotepath=false だけでは空白がクォートされる)
// - i18n.logOutputEncoding をユーザ設定に任せない (cp932 を書いている人がいる)
// - GIT_TERMINAL_PROMPT=0 は必須。CONIN$ を直接開くのでパイプでは防げず永久にハングしうる

import { spawn } from 'node:child_process';

const BASE_ARGS = [
    '-c', 'core.quotepath=false',
    '-c', 'i18n.logOutputEncoding=UTF-8',
    '-c', 'core.longpaths=true',
    ...(process.platform === 'darwin' ? ['-c', 'core.precomposeUnicode=true'] : []),
];

const BASE_ENV = {
    LANGUAGE: 'en',
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_EDITOR: 'true',
};

export class GitError extends Error {
    constructor(args, code, stderr) {
        super(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
        this.code = code;
        this.stderr = stderr;
    }
}

/**
 * git を1回実行して stdout を返す。
 * @param {string[]} args
 * @param {{cwd: string, optionalLocks?: boolean}} opts
 * @returns {Promise<string>}
 */
/**
 * git を起動した回数。1リクエストのコストを payload で観測できるようにする。
 * 「worktree 1本あたり N プロセス」という主張をテストで固定するために置いている
 * （コメントに書いただけでは回帰を防げない）。
 */
export const stats = { spawns: 0 };

/**
 * @param {object} [o]
 * @param {boolean} [o.raw] Buffer のまま返す（バイナリ判定のためデコードしない）
 * @param {number} [o.maxBytes] これを超えたら子プロセスを殺して打ち切る
 */
export function git(args, { cwd, optionalLocks = false, raw = false, maxBytes = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, ...BASE_ENV };
        // 書き込み操作では index の stat-cache 更新を許す (読み取りは 0 のまま)
        if (optionalLocks) delete env.GIT_OPTIONAL_LOCKS;

        stats.spawns++;
        const child = spawn('git', [...BASE_ARGS, ...args], {
            cwd,
            env,
            shell: false,          // ← 絶対に true にしない
            windowsHide: true,
        });

        // Buffer で受けて最後に一度だけデコードする。
        // chunk ごとの toString() は 3バイト文字を割る。
        const out = [];
        const err = [];
        let size = 0, truncated = false;
        child.stdout.on('data', c => {
            out.push(c);
            size += c.length;
            // 上限を超えたら読むのを止める。巨大な blob でメモリを食わないため。
            if (maxBytes && size > maxBytes && !truncated) {
                truncated = true;
                child.kill('SIGKILL');
            }
        });
        child.stderr.on('data', c => err.push(c));
        child.on('error', reject);
        child.on('close', code => {
            const buf = Buffer.concat(out);
            if (truncated) {
                const e = new GitError(args, code ?? 0, `出力が ${maxBytes} バイトを超えました`);
                e.truncated = true;
                reject(e);
                return;
            }
            const stderr = Buffer.concat(err).toString('utf8');
            // raw のときは code 0 でも Buffer を返す（デコードしない）
            if (code === 0) resolve(raw ? buf : buf.toString('utf8'));
            else reject(new GitError(args, code, stderr));
        });
    });
}

/** NUL 区切り出力を配列に。末尾の空要素を落とす。 */
export function splitZ(stdout) {
    const parts = stdout.split('\0');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
}

/**
 * macOS 由来の文字列は NFC に正規化する (docs/encoding-and-paths.md)。内部正規形は NFC。
 *
 * ⚠️ 正規表現は必ずエスケープで書く。当初これを生の文字で書いてしまい、ソースに
 *    生の NUL バイトが入って git がこのファイルを binary と判定し、
 *    `git log -p` に差分が出ない状態になっていた（レビューで発覚）。
 *    CLAUDE.md「スクリプトは純 ASCII に保つ」の違反でもあった。
 */
export const toNFC = process.platform === 'darwin'
    ? s => (typeof s === 'string' && /[^\x00-\x80]/.test(s) ? s.normalize('NFC') : s)
    : s => s;

/** リポジトリの共通 .git ディレクトリ (worktree でも同じ値になる) */
export async function commonDir(cwd) {
    return (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })).trim();
}

/**
 * `git worktree list --porcelain` を解析。
 * レコードは空行区切り、キーは行頭の語。bare/detached/locked/prunable はキーのみ。
 */
export async function listWorktrees(cwd) {
    const stdout = await git(['worktree', 'list', '--porcelain', '-z'], { cwd });
    // -z では各フィールドが NUL 終端、レコード間は NUL NUL
    const records = stdout.split('\0\0').filter(r => r.length > 0);
    return records.map(rec => {
        const wt = { locked: false, detached: false, bare: false, prunable: false };
        for (const field of splitZ(rec)) {
            const sp = field.indexOf(' ');
            const key = sp === -1 ? field : field.slice(0, sp);
            const val = sp === -1 ? '' : field.slice(sp + 1);
            switch (key) {
                case 'worktree': wt.path = toNFC(val); break;
                case 'HEAD': wt.head = val; break;
                case 'branch': wt.branch = val; break;   // refs/heads/xxx
                case 'bare': wt.bare = true; break;
                case 'detached': wt.detached = true; break;
                case 'locked': wt.locked = true; wt.lockReason = val; break;
                // prunable は理由を伴う（`prunable gitdir file points to non-existent location`）。
                // フラグだけにすると UI が「(true)」と出して原因が分からなくなる。
                case 'prunable': wt.prunable = true; wt.prunableReason = val || null; break;
            }
        }
        wt.name = wt.path ? wt.path.split(/[\\/]/).pop() : '(unknown)';
        // ブランチ名も NFC 正規化する（macOS で日本語ブランチ名がパスと不一致になるため）
        if (wt.branch) wt.branch = toNFC(wt.branch);
        wt.shortBranch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : null;
        return wt;
    }).filter(wt => wt.path);
}

// レコード区切りは改行、フィールド区切りは NUL。
// ⚠️ レコード区切りにも NUL を使ってはいけない: %D (refs) が空だと
//    「...subject\0<空>\0\0」で NUL が3連続し、\0\0 での分割が1つずれて
//    以降の全フィールドがシフトする（実際にこのバグを踏んだ）。
//    %s と %D はどちらも改行を含まないので \n は安全な区切りになる。
//    %s は最も内容が予測しづらいので末尾に置く。
const LOG_FORMAT = ['%H', '%P', '%an', '%aI', '%D', '%s'].join('%x00');

/**
 * 指定した ref 群を含むコミットを新しい順に取得する。
 * @param {string[]} refs
 */
export async function log(cwd, refs, limit = 300) {
    if (refs.length === 0) return [];
    const stdout = await git([
        'log', '--topo-order', `--max-count=${limit}`,
        `--pretty=format:${LOG_FORMAT}`,
        ...refs, '--',
    ], { cwd });

    return stdout.split('\n').filter(line => line.length > 0).map(rec => {
        const [hash, parents, author, date, refNames, subject] = rec.split('\0');
        // author / subject / refs も NFC 正規化する。
        // 当初パスにしか適用しておらず、macOS で日本語ブランチ名が
        // カードのバッジ（未正規化）とパス（正規化済み）で不一致になりえた（レビューで発覚）。
        return {
            hash,
            parents: parents ? parents.split(' ').filter(Boolean) : [],
            author: toNFC(author ?? ''),
            date,
            subject: toNFC(subject ?? ''),
            refs: refNames
                ? refNames.split(', ').map(s => toNFC(s.trim())).filter(Boolean)
                : [],
        };
    }).filter(c => /^[0-9a-f]{40}$/.test(c.hash ?? ''));
}

/** マージベース。無ければ null (無関係な履歴)。 */
export async function mergeBase(cwd, a, b) {
    try {
        return (await git(['merge-base', a, b], { cwd })).trim();
    } catch {
        return null;
    }
}

/** base..head の ahead と、その逆の behind */
export async function aheadBehind(cwd, base, head) {
    try {
        const out = (await git(['rev-list', '--left-right', '--count', `${base}...${head}`], { cwd })).trim();
        const [behind, ahead] = out.split(/\s+/).map(Number);
        return { ahead, behind };
    } catch {
        return { ahead: 0, behind: 0 };
    }
}

/** base..head で変更されたファイル。-z なのでクォートされない。 */
export async function changedFiles(cwd, base, head) {
    const stdout = await git(['diff', '--name-status', '-z', `${base}...${head}`], { cwd });
    const parts = splitZ(stdout);
    const files = [];
    for (let i = 0; i < parts.length;) {
        const status = parts[i++];
        if (status === undefined) break;
        // R/C は「status\0from\0to」の3トークン
        if (status[0] === 'R' || status[0] === 'C') {
            const from = parts[i++], to = parts[i++];
            files.push({ status: status[0], path: toNFC(to ?? ''), from: toNFC(from ?? '') });
        } else {
            files.push({ status: status[0], path: toNFC(parts[i++] ?? '') });
        }
    }
    return files;
}

/**
 * 作業ツリーの未コミット変更（dirty 判定用）。
 *
 * ⚠️ porcelain=v2 の `-z` では rename/copy エントリが
 *    「`2 ... <path>` NUL `<origPath>`」の**2トークン**になる。
 *    NUL をレコード区切りとして扱うと origPath が独立エントリに見え、
 *    旧パスが `1 `/`2 `/`? `/`u ` で始まっていると二重にカウントされる。
 *    （`log()` の `%D` で踏んだのと同じ罠をここでも踏んでいた。レビューで発覚）
 */
export async function worktreeStatus(cwd) {
    const stdout = await git(['status', '--porcelain=v2', '-z', '--untracked-files=normal'], { cwd });
    const entries = splitZ(stdout);
    let changed = 0, untracked = 0, unmerged = 0;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.startsWith('2 ')) { changed++; i++; continue; }   // 次のトークンは origPath
        if (e.startsWith('1 ')) changed++;
        else if (e.startsWith('u ')) { changed++; unmerged++; }
        else if (e.startsWith('? ')) untracked++;
        // '! ' (ignored) と '# ' (header) は無視
    }
    return { changed, untracked, unmerged, dirty: changed > 0 || untracked > 0 };
}

/**
 * 全 ref を1プロセスで OID に解決した表を作る。
 *
 * ⚠️ worktree ごとに `rev-parse --verify` を叩くと本数に比例して
 *    プロセスが増える（11本で1リクエスト 59 spawn になっていた）。
 *    ref の解決は表引きで済むので、ここで1回だけ集める。
 *
 * ⚠️ `for-each-ref` に `-z` は無い（`unknown switch 'z'` で 129 終了する）。
 *    git は refname に改行を許さないので、レコード区切りは改行、
 *    フィールド区切りは `%00` で安全に分けられる（LOG_FORMAT と同じ理屈）。
 */
export async function refMap(cwd) {
    const out = await git(
        ['for-each-ref', '--format=%(refname)%00%(objectname)'],
        { cwd },
    );
    const map = new Map();
    for (const line of out.split('\n')) {
        if (!line) continue;
        const [refname, oid] = line.split('\0');
        if (refname && oid) map.set(toNFC(refname), oid.trim());
    }
    return map;
}

/**
 * refMap を使って ref を OID に解決する。プロセスを起こさない。
 * 完全な OID はそのまま通す（`worktree list` の HEAD は構成上必ず有効）。
 */
export function resolveRef(map, ref) {
    if (!ref) return null;
    if (map.has(ref)) return map.get(ref);
    for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
        if (map.has(prefix + ref)) return map.get(prefix + ref);
    }
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
    return null;
}

/**
 * worktree のパス → その worktree の $GIT_DIR。
 *
 * `<commonDir>/worktrees/<id>/gitdir` には各 worktree の `.git` ファイルの
 * パスが入っている。これを読めば worktree ごとに
 * `rev-parse --git-dir` を叩かずに済む（プロセス削減）。
 * ここに現れない worktree はメイン worktree なので $GIT_DIR は commonDir。
 */
export async function worktreeGitDirs(common) {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const map = new Map();
    let entries = [];
    try {
        entries = await readdir(join(common, 'worktrees'), { withFileTypes: true });
    } catch {
        return map;   // linked worktree が無いリポジトリ
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const gitDir = join(common, 'worktrees', e.name);
        try {
            const dotGit = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim();
            if (dotGit) map.set(toNFC(dirname(dotGit)), gitDir);
        } catch { /* 壊れたエントリは無視して rev-parse に任せる */ }
    }
    return map;
}

/**
 * 存在するコミットに解決できる ref だけを返す。
 * これを通さずに `log()` に渡すと、古い `origin/HEAD` や
 * 誤った `--base` ひとつでエンドポイント全体が 500 になる（レビューで発覚）。
 *
 * 単発の検証用。ループで呼ぶなら refMap()/resolveRef() を使うこと。
 */
export async function verifyRefs(cwd, refs) {
    const ok = [];
    for (const ref of refs) {
        if (!ref) continue;
        try {
            await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
            ok.push(ref);
        } catch { /* 解決できない ref は捨てる */ }
    }
    return ok;
}

/**
 * 同じパスを指しているか。
 *
 * ⚠️ 区切り文字を揃えずに `===` で比べてはいけない。git は Windows でも
 *    `C:/Users/...` と**スラッシュ**で返すが、クライアントが `path.join()` で
 *    作った値は `\` になる。worktree の allowlist 照合をこれで落とした。
 *    Windows / macOS は大文字小文字を区別しないので畳んで比べる
 *    （allowlist との比較なので、緩めても既知の worktree にしか一致しない）。
 */
export function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const norm = s => {
        let t = toNFC(s).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
        if (process.platform === 'win32' || process.platform === 'darwin') t = t.toLowerCase();
        return t;
    };
    return norm(a) === norm(b) && a !== '' && b !== '';
}

/**
 * リポジトリ内のパスとして受け付けてよいかを検証する。
 *
 * ⚠️ これはネットワーク越しに来る値を git に渡す唯一の経路なので、
 *    ここが緩いとリポジトリ外が読める。git 自身も `..` を弾くが、
 *    多重防御として手前でも落とす。
 *    - NUL: `-z` の解析を壊し、引数の途中で切られる
 *    - 絶対パス / ドライブレター: リポジトリ外
 *    - `..` セグメント: 親へ抜ける
 *    - 先頭の `-`: git のオプションとして解釈されうる
 */
export function isSafeRepoPath(p) {
    if (typeof p !== 'string' || p === '' || p.length > 4096) return false;
    if (p.includes('\0')) return false;
    if (p.startsWith('-')) return false;
    if (p.startsWith('/') || p.startsWith('\\')) return false;
    if (/^[a-zA-Z]:/.test(p)) return false;
    const parts = p.split(/[\\/]/);
    if (parts.some(s => s === '..')) return false;
    return true;
}

/**
 * ref として受け付けてよいか。
 * `機能/新規` のような日本語ブランチ名は通す（スラッシュは正当）。
 * `HEAD~1` のようなリビジョン式は使わないので `~` `^` ごと弾いておく。
 */
export function isSafeRef(r) {
    if (typeof r !== 'string' || r === '' || r.length > 512) return false;
    if (r.includes('\0') || r.startsWith('-')) return false;
    if (/[\s~^:?*[\]\\]/.test(r)) return false;
    if (r.includes('..')) return false;
    return true;
}

const MAX_BLOB_BYTES = 512 * 1024;

/** 先頭 8000 バイトに NUL があれば binary（git と同じ判定）。 */
function looksBinary(buf) {
    return buf.subarray(0, 8000).includes(0);
}

/**
 * `<ref>:<path>` の中身を読む。**追跡されている内容だけ**を返す。
 *
 * fs で直接読まないのは、リポジトリ外や未追跡の秘密ファイル
 * （`.env` 等）に触れる経路を作らないため。git のオブジェクト経由なら
 * 「コミットに入っているもの」に限定される。
 */
export async function showBlob(cwd, ref, path) {
    if (!isSafeRef(ref)) throw new GitError(['blob'], 2, `ref が不正です: ${ref}`);
    if (!isSafeRepoPath(path)) throw new GitError(['blob'], 2, `path が不正です: ${path}`);

    // 先にサイズを見る。大きい blob を読み込んでから捨てるのを避ける。
    let size = 0;
    try {
        size = Number((await git(['cat-file', '-s', `${ref}:${path}`], { cwd })).trim());
    } catch (err) {
        throw new GitError(['blob'], 2, `見つかりません: ${ref}:${path}`);
    }
    if (size > MAX_BLOB_BYTES) {
        return { path, ref, size, tooLarge: true, binary: false, text: null };
    }
    const buf = await git(['cat-file', 'blob', `${ref}:${path}`],
        { cwd, raw: true, maxBytes: MAX_BLOB_BYTES + 1024 });
    if (looksBinary(buf)) {
        return { path, ref, size, tooLarge: false, binary: true, text: null };
    }
    return {
        path, ref, size, tooLarge: false, binary: false,
        text: toNFC(buf.toString('utf8')),
    };
}

/**
 * 1ファイルの unified diff。`base...ref` の三点記法。
 * ⚠️ `--` の後ろにパスを置く。これが無いと path が ref として解釈されうる。
 */
export async function fileDiff(cwd, base, ref, path) {
    if (!isSafeRef(base)) throw new GitError(['diff'], 2, `base が不正です: ${base}`);
    if (!isSafeRef(ref)) throw new GitError(['diff'], 2, `ref が不正です: ${ref}`);
    if (!isSafeRepoPath(path)) throw new GitError(['diff'], 2, `path が不正です: ${path}`);
    const buf = await git([
        'diff', '--no-color', '--no-ext-diff', `${base}...${ref}`, '--', path,
    ], { cwd, raw: true, maxBytes: MAX_BLOB_BYTES + 1024 });
    if (looksBinary(buf)) return { path, binary: true, text: null };
    return { path, binary: false, text: toNFC(buf.toString('utf8')) };
}

/** ref から到達できるコミットの集合（グラフの幹を決めるのに使う）。 */
export async function reachable(cwd, ref, limit = 2000) {
    try {
        const out = await git(['rev-list', `--max-count=${limit}`, ref], { cwd });
        return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/**
 * 🚨 シーケンサ状態の検出 (docs/encoding-and-paths.md / s0-verification.md)。
 * clean index の rebase 中は checkout/commit/merge が exit 0 で通り、
 * rebase --continue が別ブランチにリプレイする。
 * MERGE_HEAD は checkout -b で無警告に消える。
 * → 「どのツールもガードしていない」ことを確認済みの領域。
 */
export async function sequencerState(cwd, knownGitDir = null) {
    // knownGitDir が分かっていれば rev-parse を省く（worktreeGitDirs 参照）
    const gitDir = knownGitDir
        ?? (await git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd })).trim();
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const p = n => join(gitDir, n);
    const read = n => { try { return readFileSync(p(n), 'utf8').trim(); } catch { return null; } };

    const state = {
        rebasing: existsSync(p('rebase-merge')) || existsSync(p('rebase-apply')),
        merging: existsSync(p('MERGE_HEAD')),
        cherryPicking: existsSync(p('CHERRY_PICK_HEAD')),
        reverting: existsSync(p('REVERT_HEAD')),
        bisecting: existsSync(p('BISECT_LOG')),
        rebaseHeadName: read('rebase-merge/head-name'),
        warnings: [],
    };

    const head = read('HEAD');
    state.headRef = head && head.startsWith('ref: ') ? head.slice(5) : null;

    // 乗っ取り検出: rebase 中なのに HEAD が rebase 対象ブランチを指していない
    if (state.rebasing && state.rebaseHeadName && state.headRef
        && state.rebaseHeadName !== state.headRef) {
        state.warnings.push({
            level: 'danger',
            code: 'sequencer-hijack',
            message: `rebase は ${state.rebaseHeadName} に対して進行中だが HEAD は ${state.headRef} を指している。`
                + ' このまま rebase --continue すると間違ったブランチにリプレイされる。',
        });
    }
    if (state.merging) {
        state.warnings.push({
            level: 'warn',
            code: 'merge-head-present',
            message: 'MERGE_HEAD が存在する。この状態で checkout すると無警告で削除され、'
                + '次の commit が単一親になる（マージの関係が失われる）。',
        });
    }
    return state;
}
