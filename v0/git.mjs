// SPDX-License-Identifier: MIT
// git の起動は docs/encoding-and-paths.md の「正典のレシピ」に従う。
// - spawn(gitPath, argvArray) で shell は絶対に使わない
//   (injection と、日本語ファイル名が約85文字で落ちる msys2 NAME_MAX 問題を同時に回避)
// - パスを含むコマンドは -z (core.quotepath=false だけでは空白がクォートされる)
// - i18n.logOutputEncoding をユーザ設定に任せない (cp932 を書いている人がいる)
// - GIT_TERMINAL_PROMPT=0 は必須。CONIN$ を直接開くのでパイプでは防げず永久にハングしうる

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, sep, resolve } from 'node:path';

const BASE_ARGS = [
    '-c', 'core.quotepath=false',
    '-c', 'i18n.logOutputEncoding=UTF-8',
    '-c', 'core.longpaths=true',
    // 🚨 観測対象のリポジトリ設定を信頼しない。
    //    `.git/config` に書ける相手（= 並行して動いている別のエージェント）が
    //    `core.fsmonitor` にコマンドを書くと、**読み取り専用のはずの
    //    `git status` がそれを実行する**。デーモンの env をそのまま継承するので
    //    トークンの持ち出しにも使える（レビューで実証された）。
    //    N 個のエージェントが同じ common dir を共有する前提のツールなので、
    //    「読み取りだけなら安全」は設定を無効化して初めて成立する。
    '-c', 'core.fsmonitor=false',
    // pathspec magic（`:(exclude)…` `:!…` `:/…`）を無効化する。
    // これが無いと 1ファイル指定のはずの diff が他のファイルを含んで返る。
    '--literal-pathspecs',
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
/**
 * @param {number[]} [o.allowExit] 成功として扱う終了コード（既定は [0]）。
 *   `merge-tree` は**衝突を 1 で返す**ので、それを失敗にしないために要る。
 * @param {boolean} [o.withCode] `{ code, stdout, stderr }` を返す。
 *   終了コードで結果が変わるコマンド（merge-tree）向け。
 */
export function git(args, {
    cwd, optionalLocks = false, raw = false, maxBytes = 0,
    allowExit = [0], withCode = false,
} = {}) {
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
            if (!allowExit.includes(code)) {
                reject(new GitError(args, code, stderr));
                return;
            }
            const value = raw ? buf : buf.toString('utf8');
            // ⚠️ 終了コードを見たい呼び出し元には {code, stdout} を返す。
            //    モジュール変数に最後の code を置くのは並行呼び出しで壊れる。
            resolve(withCode ? { code, stdout: value, stderr } : value);
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
export async function worktreeStatus(cwd, filterNames = []) {
    const stdout = await git(
        [...filterNeutralizeArgs(filterNames),
            'status', '--porcelain=v2', '-z', '--untracked-files=normal'],
        { cwd },
    );
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
 * ⚠️ 文字列を `===` で比べてはいけない。同じ場所を指す3種類の差がある:
 *
 *  1. **区切り文字。** git は Windows でも `C:/Users/...` と**スラッシュ**で返すが、
 *     クライアントが `path.join()` で作った値は `\` になる
 *  2. **大文字小文字。** Windows / macOS は区別しない
 *  3. **8.3 短縮名とシンボリックリンク。** Windows CI の `os.tmpdir()` は
 *     `C:\Users\RUNNER~1\...` と**短縮名**を返すのに git は `runneradmin` と
 *     長い形を返す。macOS では `os.tmpdir()` の `/var/...` が実体 `/private/var/...`。
 *     → `realpathSync.native()` で実体に解決してから比べる
 *
 * 3 を入れていなかったせいで、worktree の allowlist 照合が windows CI だけで
 * 落ちた（手元の Windows では tmpdir が短縮名にならないので再現しなかった）。
 *
 * allowlist との比較にしか使わないので、緩めても既知の worktree にしか一致しない。
 */
/**
 * パスを比較用に畳む。
 *
 * @param {string} s
 * @param {boolean} [resolveAncestor]
 *   実体が無いとき、**存在する最も近い祖先を realpath して継ぎ足す**。
 *   これが無いと「まだ作っていないファイル」を含む比較が黙って外れる:
 *   macOS の `/var` → `/private/var`、Windows の `RUNNER~1` → `runneradmin`
 *   （CI の Windows と macOS だけ落ちた原因はこれ。手元では temp のパスが
 *   短くて 8.3 短縮名にならないので再現しなかった）
 */
function normPath(s, resolveAncestor = false) {
    const isWin = process.platform === 'win32';
    let t = s;
    try {
        t = realpathSync.native(t);
    } catch {
        // 実体が無い（prunable worktree、これから作るファイル）
        if (resolveAncestor) {
            const parts = t.split(/[\\/]+/);
            const tail = [];
            while (parts.length > 1) {
                tail.unshift(parts.pop());
                try { t = join(realpathSync.native(parts.join(sep) || sep), ...tail); break; }
                catch { /* もう1つ上を試す */ }
            }
        }
    }
    t = toNFC(t);
    // ⚠️ バックスラッシュを区切りとして畳むのは **Windows だけ**。
    //    POSIX では `\` は正当なファイル名の文字なので、畳むと
    //    `a\b`（1つのファイル名）と `a/b`（2階層）を同一視してしまう。
    //    これは allowlist の照合に使うので、緩めてよい話ではない。
    t = isWin ? t.replace(/[\\/]+/g, '/') : t.replace(/\/+/g, '/');
    t = t.replace(/\/+$/, '');
    if (isWin || process.platform === 'darwin') t = t.toLowerCase();
    return t;
}

/**
 * `child` が `parent` の中なら**元の表記のまま**の相対パスを返す。
 * parent 自身なら `''`、外なら `null`。
 *
 * ⚠️ **素の `path.relative()` で判定も計算もしない。** 表記が違うと
 *    （8.3 短縮名 / symlink / 大文字小文字）`../../..` を返すので、
 *    「中にあるファイルのパスを見失う」形で静かに壊れる。
 * ⚠️ **正規化した文字列をそのまま返してはいけない。** normPath は
 *    Windows / macOS で小文字化するが、**git のパスは大文字小文字を区別する**
 *    （`v0/Git.mjs` と `v0/git.mjs` は別物）。小文字化したものを返すと
 *    `git cat-file` が引けない。だから「要素数だけ正規形で決め、
 *    値は元の表記から取る」。
 */
export function relativeInside(parent, child) {
    if (typeof parent !== 'string' || typeof child !== 'string') return null;
    if (parent === '' || child === '') return null;
    const p = normPath(parent, true);
    const c = normPath(child, true);
    if (p === '' || c === '') return null;
    if (c === p) return '';
    if (!c.startsWith(`${p}/`)) return null;
    const depth = c.slice(p.length + 1).split('/').length;
    const isWin = process.platform === 'win32';
    const orig = toNFC(child)
        .replace(isWin ? /[\\/]+/g : /\/+/g, '/')
        .replace(/\/+$/, '')
        .split('/');
    // 🚨 **元表記の残り段数が depth より少ないなら諦める（null = 外として扱う）。**
    //    junction / symlink が**リポジトリの中の深い場所**を指していて、記録が
    //    その外側の綴りを使っていると、解決後の残り段数が元表記の段数を上回り、
    //    `orig.slice(-depth)` が**リポジトリ外の親ディレクトリ名を巻き込む**。
    //    それが `isSafeRepoPath` を通るので `outside:false` で payload に載り、
    //    「リポジトリ外のパスは出さない」が破れる（外のディレクトリ名が漏れ、
    //    存在しないパスを「触ったファイル」として表示する嘘にもなる）。
    //    ⚠️ ここは**推測して埋めない**。対応が取れないなら外と言う（7回目のレビュー）。
    if (orig.length < depth) return null;
    return orig.slice(orig.length - depth).join('/');
}

/**
 * `child` が `parent` の中（または parent 自身）か。
 *
 * ⚠️ `--token-file` をリポジトリの外に強制するのに使っているので、
 *    外れると**実行トークンがコミットされる**（漏洩事故になる）。
 */
export function containsPath(parent, child) {
    return relativeInside(parent, child) !== null;
}

export function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a === '' || b === '') return false;
    const isWin = process.platform === 'win32';
    const norm = s => {
        let t = s;
        try {
            // 存在しないパスでは throw するので、そのときは文字列のまま比べる
            t = realpathSync.native(t);
        } catch { /* 実体が無い（prunable worktree 等）。文字列比較にフォールバック */ }
        t = toNFC(t);
        // ⚠️ バックスラッシュを区切りとして畳むのは **Windows だけ**。
        //    POSIX では `\` は正当なファイル名の文字なので、畳むと
        //    `a\b`（1つのファイル名）と `a/b`（2階層）を同一視してしまう。
        //    これは allowlist の照合に使うので、緩めてよい話ではない。
        t = isWin ? t.replace(/[\\/]+/g, '/') : t.replace(/\/+/g, '/');
        t = t.replace(/\/+$/, '');
        if (isWin || process.platform === 'darwin') t = t.toLowerCase();
        return t;
    };
    return norm(a) === norm(b);
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
    // ⚠️ pathspec magic を弾く。`:(exclude)x` `:!x` `:/x` は「1ファイル指定」を
    //    「それ以外全部」に変えてしまう（BASE_ARGS の --literal-pathspecs でも
    //    無効化しているが、入口でも落として二重に守る）。
    if (p.startsWith(':')) return false;
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
    // ⚠️ `@{…}` を弾く。`agent-a@{1}` や `main@{upstream}` は reflog を辿るので、
    //    `reset --hard` で捨てたコミットの中身まで読めてしまう。
    //    「コミットに入っているものに限定される」という showBlob の主張が崩れる
    //    （レビューで実証された）。
    if (r.includes('@{') || r === '@') return false;
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

    // ⚠️ まず**不変の OID に解決してから**中身を読む。
    //    以前は `cat-file -s <ref>:<path>` と `cat-file blob <ref>:<path>` を
    //    別々に叩いていたので、その間にブランチが動くと size と text が
    //    別オブジェクトのものになりえた（TOCTOU。レビューで指摘）。
    //    OID は動かないので、解決さえ済めば競合は無い。
    let oid;
    try {
        oid = (await git(
            ['rev-parse', '--verify', '--end-of-options', `${ref}:${path}`], { cwd },
        )).trim();
    } catch {
        throw new GitError(['blob'], 2, `見つかりません: ${ref}:${path}`);
    }
    if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
        throw new GitError(['blob'], 2, `OID に解決できません: ${ref}:${path}`);
    }

    let buf;
    try {
        buf = await git(['cat-file', 'blob', oid],
            { cwd, raw: true, maxBytes: MAX_BLOB_BYTES + 1024 });
    } catch (err) {
        if (!err.truncated) throw err;
        // 上限を超えた。サイズだけ同じ OID から取る（別オブジェクトにはならない）
        let size = null;
        try { size = Number((await git(['cat-file', '-s', oid], { cwd })).trim()); } catch { /* 諦める */ }
        // binary は「読まなかったので分からない」。false と断定すると未知を偽る
        // ⚠️ `limitBytes` を返すのは、**UI が上限を二重に書かないため**。
        //    画面側に定数を写すと、片方だけ変えたときに告知の数字が嘘になる。
        return {
            path, ref, oid, size, tooLarge: true, binary: null, text: null,
            limitBytes: MAX_BLOB_BYTES,
        };
    }
    // サイズは読んだバイト数そのもの（別に問い合わせないので齟齬が起きない）
    const size = buf.length;
    if (looksBinary(buf)) {
        return { path, ref, oid, size, tooLarge: false, binary: true, text: null };
    }
    return {
        path, ref, oid, size, tooLarge: false, binary: false,
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
    // --no-textconv も必須。--no-ext-diff は textconv を止めないので、
    // リポジトリ設定の `diff.<name>.textconv` からコマンドが起動しうる。
    const buf = await git([
        'diff', '--no-color', '--no-ext-diff', '--no-textconv',
        `${base}...${ref}`, '--', path,
    ], { cwd, raw: true, maxBytes: MAX_BLOB_BYTES + 1024 });
    if (looksBinary(buf)) return { path, binary: true, text: null };
    return { path, binary: false, text: toNFC(buf.toString('utf8')) };
}

/**
 * 2つの ref を**実際にマージしてみて**衝突するかを調べる。作業ツリーには触らない。
 *
 * これが要る理由: 「同じファイルを触っている」は代理指標にすぎず、
 * 実際に衝突するかは分からない。N 本の worktree が並行に動く前提のツールでは
 * 「本当にぶつかるのはどれか」が判断の中心になる。
 *
 * ⚠️ `--write-tree` は**オブジェクトDB に loose object を書く**。
 *    ref / index / 作業ツリーには触らないので他のエージェントからは観測できないが、
 *    「書き込みは一切しない」とは言えない（gc で回収される）。
 * ⚠️ 衝突は **exit 1** で返る。失敗と区別するため withCode を使う。
 * ⚠️ `-z` の出力は
 *      <tree OID> NUL (衝突パス NUL)* NUL (件数 NUL パス NUL 種別 NUL 説明 NUL)*
 *    で、**空トークンがセクション区切り**。NUL をレコード区切りとして
 *    素朴に split すると情報メッセージ側のパスを衝突パスと混同する。
 */
const MAX_MERGE_TREE_BYTES = 2 * 1024 * 1024;

/**
 * 観測対象リポジトリで定義されている custom merge driver の名前を列挙する。
 *
 * 🚨 これを無効化しないと `merge-tree` が**任意コマンドを実行する。**
 *    コミット済みの `.gitattributes`（`*.txt merge=evil`）と
 *    `.git/config` の `[merge "evil"] driver = ...` の2つで、
 *    `/api/v0/state` を1回叩くだけでデーモンの env ごとコードが走る
 *    （`--allow-write` も不要。レビューでビーコン付きで実証された）。
 *    `core.fsmonitor` と同じクラスの穴。
 */
/**
 * 🔒 **`.gitattributes` の filter を無効化する引数を組む。**
 *
 * `core.fsmonitor` と**完全に同じクラスの穴**が filter 側に残っていた（8回目のレビュー）。
 * コミット済みの `.gitattributes`（`*.txt filter=evil`）と `.git/config` の
 * `[filter "evil"] clean = <コマンド>` の2つで、**capability ゼロの読み取り専用デーモンが
 * `/api/v0/state` を1回処理するだけでコマンドを実行する**（`git status` は作業ツリーと
 * index の中身を比べるときに clean filter を通す。実測で marker が書かれた）。
 * `.git/config` を書けるのは並行して動いている別のエージェントなので、
 * まさにこのツールの脅威モデルの中心。
 *
 * ⚠️ **潰し方は実測で選んだ（組み合わせを1つずつ切り分けた）。**
 *   | 渡すもの | filter を止める | `required=true` でも動く |
 *   |---|---|---|
 *   | `clean=cat` | ✔ | ✔ |
 *   | `clean=`（空） | ✔ | ✖ `fatal: clean filter failed` |
 *   | `process=`（空） | ✔ | ✖ fatal |
 *   | `smudge=cat` | **✖ 止まらない** | — |
 *
 * だから **`clean=cat` を常に渡し、`process` は設定されているときだけ潰す**。
 * `process` は `clean` より優先されるので潰さないと素通りするが、
 * 潰すと `required=true` の filter で status が fatal になる
 * （git-lfs は既定で required。**全部潰すと lfs のリポジトリで読み取りが壊れる**）。
 * 壊れる側に倒すのは意図的: 実行させるより「読めない」と言う方が安全。
 * ⚠️ `smudge` は渡さない（読み取り経路では走らないので、**測れない守りは置かない**）。
 *
 * @param {{name: string, hasProcess: boolean}[]} filters `repoFilterNames()` の結果
 */
export function filterNeutralizeArgs(filters) {
    const args = [];
    for (const f of filters ?? []) {
        const name = typeof f === 'string' ? f : f?.name;
        if (!name) continue;
        args.push('-c', `filter.${name}.clean=cat`);
        if (f?.hasProcess) args.push('-c', `filter.${name}.process=`);
    }
    return args;
}

/**
 * 🔒 **リポジトリに書かれた filter の名前を集める。**
 *
 * ⚠️ **`--local` と `--worktree` だけを見る。** `.git/config` は並行エージェントが
 *    書ける（= 攻撃面）が、`~/.gitconfig` は利用者自身の設定。global まで潰すと
 *    **git-lfs のリポジトリで status が全ファイル「変更」になり、観測が嘘になる**
 *    （lfs は clean/smudge/process を使うので、`cat` で素通しすると
 *     index のポインタと作業ツリーの実体を比べることになる）。
 *    どちらを潰したかは呼び出し側が告知する。
 */
export async function repoFilterNames(cwd) {
    /** name → process が設定されているか（潰し方が変わるので分ける） */
    const found = new Map();
    try {
        // 🚨 **判定は「出所のパス」ではなく git が言う scope で行う（9回目のレビュー。BLOCKING）。**
        //
        //    以前は `--show-origin` の**ファイルの場所**が `.git` の中かで採否を決めていた。
        //    ところが `.git/config` の `include.path` は**`.git` の外のファイル**を読めるので、
        //    filter の定義を worktree 直下（`<repo>/evil.cfg`）に置くだけで
        //    「リポジトリの中ではない」と判定され、**capability ゼロの任意コード実行が
        //    そのまま復活していた**（実測: フラグ0個のデーモンに state を1回投げて marker が
        //    2回書かれ、告知は0件。merge の門も 200 で通過）。
        //    `--local` で列挙しても取れない（include された値は local スコープの
        //    ファイルに帰属しないので exit 1 になる。実測）。
        //
        //    ⚠️ **許可リストに反転する。** `--show-scope` は include で引かれた値
        //    （2段でも）を `local` と報告する（実測）。だから
        //    **`system` / `global` 以外はすべてリポジトリ側**として扱う。
        //    知らない scope（`command` など、将来増えるもの）も**保守的に潰す側**へ。
        // ⚠️ spawn は1回のまま（`stats.gitSpawns` の予算を増やさない）。
        const out = await git(
            ['config', '--show-scope', '--get-regexp',
                '^filter\\..*\\.(clean|smudge|process)$'],
            { cwd, allowExit: [0, 1] },   // 1 = 該当なし
        );
        for (const raw of out.split('\n')) {
            const l = raw.trim();
            if (!l) continue;
            // 形: `<scope>\tfilter.<name>.<key> <value>`
            const m = /^([a-z]+)\t+filter\.(.+?)\.(clean|smudge|process)(?:\s|$)/.exec(l);
            if (!m) continue;
            const [, scope, name, key] = m;
            // 🔒 利用者自身の設定（git-lfs など）は潰さない。潰すと lfs の
            //    リポジトリで status が全ファイル「変更」になり、観測が嘘になる
            if (scope === 'system' || scope === 'global') continue;
            const prev = found.get(name) ?? false;
            found.set(name, prev || key === 'process');
        }
    } catch { /* 判定できなければ空（呼び出し側が保守的に扱う） */ }
    return [...found].map(([name, hasProcess]) => ({ name, hasProcess }));
}

export async function mergeDriverNames(cwd) {
    try {
        const out = await git(
            ['config', '--get-regexp', '^merge\\..*\\.driver$'],
            { cwd, allowExit: [0, 1] },   // 1 = 該当なし
        );
        return [...new Set(out.split('\n')
            .map(l => /^merge\.(.+)\.driver\s/.exec(l.trim())?.[1])
            .filter(Boolean))];
    } catch {
        return [];   // 判定できなければ空（呼び出し側が保守的に扱う）
    }
}

/**
 * 2つの ref を**実際にマージしてみて**衝突するかを調べる。作業ツリーには触らない。
 *
 * @param {string[]} [driverNames] 無効化する merge driver の名前（mergeDriverNames の結果）
 */
export async function mergePreview(cwd, refA, refB, driverNames = []) {
    if (!isSafeRef(refA) || !isSafeRef(refB)) {
        throw new GitError(['merge-tree'], 2, `ref が不正です: ${refA} / ${refB}`);
    }
    // 🚨 driver を潰す。潰すと保守的に「衝突」側へ倒れるので、
    //    呼び出し側は driver があったことを利用者に伝える必要がある。
    const kill = driverNames.flatMap(n => ['-c', `merge.${n}.driver=false`]);
    let r;
    try {
        r = await git(
            [...kill, 'merge-tree', '--write-tree', '-z', '--name-only',
                '--end-of-options', refA, refB],
            {
                cwd, allowExit: [0, 1], withCode: true,
                // 巨大な衝突（両側が数千ファイルを触る）で無制限に読まない
                maxBytes: MAX_MERGE_TREE_BYTES,
            },
        );
    } catch (err) {
        if (err.truncated) {
            // 読み切れなかった。衝突の有無を断定しない
            return { clean: null, conflicts: [], truncated: true };
        }
        throw err;
    }
    // 0 = きれいにマージできる
    if (r.code === 0) return { clean: true, conflicts: [] };

    // 🚨 exit 1 は「衝突」と「そもそもマージできない」の**両方**を意味する。
    //    `merge-tree main no-such-ref` は exit 1 で stdout 0 バイトになるので、
    //    区別しないと `{clean:false, conflicts:[]}` という**嘘**を返す
    //    （「衝突している。ただし衝突ファイルは0件」。レビューで実証）。
    //    tree OID が出ているかどうかで判別する。
    const parts = r.stdout.split('\0');
    const oid = parts.shift() ?? '';
    if (!/^[0-9a-f]{40,64}$/i.test(oid.trim())) {
        throw new GitError(['merge-tree', refA, refB], r.code,
            r.stderr || 'マージできません（tree が出力されていない）');
    }
    const conflicts = [];
    let i = 0;
    for (; i < parts.length; i++) {
        if (parts[i] === '') break;      // 空トークンでセクション終わり
        conflicts.push(toNFC(parts[i]));
    }
    // 衝突と言うなら必ず1件以上あるはず。0件なら判定できていない
    if (conflicts.length === 0) {
        throw new GitError(['merge-tree', refA, refB], r.code,
            r.stderr || '衝突と報告されたが衝突ファイルが0件');
    }

    // 🚨 **情報メッセージから「実在しない退避名」を取り出す。**
    //    `--name-only` の衝突パスには git が作る退避名が混ざる（実測:
    //    `thing~refs_heads_synth-b`）。それを普通のファイル名として出すと
    //    UI で押しても開けない行き止まりになる（#1）。
    //    接尾辞から推測すると外れる（label でもハッシュでもなく `refs_heads_...`
    //    だった）ので、**git が言っている通りに取る**:
    //      `CONFLICT (file/directory): directory in the way of thing from B;
    //       moving it to thing~B instead.`
    //    ⚠️ メッセージは英語に固定されている（BASE_ARGS で LANGUAGE=en / LC_ALL）。
    const info = parts.slice(i + 1).join('\n');
    const synthetic = new Map();   // 退避名 → 実体のパス
    for (const m of info.matchAll(/in the way of (.+?) from [^;]+; moving it to (.+?) instead/g)) {
        synthetic.set(toNFC(m[2].trim()), toNFC(m[1].trim()));
    }
    // symlink 絡みなど別の文面もあるので、退避名だけでも拾う
    for (const m of info.matchAll(/moving it to (.+?) instead/g)) {
        const name = toNFC(m[1].trim());
        if (!synthetic.has(name)) synthetic.set(name, null);
    }
    // 🚨 **submodule は「衝突する」ではなく「判定できない」。**
    //    git 自身が hint でそう言っている（実測）:
    //      `hint: Recursive merging with submodules currently only supports
    //       trivial cases.` / `CONFLICT (submodule)` / `Failed to merge submodule mod`
    //    これを普通の衝突として出すのは、`{clean:false, conflicts:[]}` を返していた
    //    過去の不具合と同じ「嘘」の型（#2）。3値（clean / conflict / 不明）の
    //    「不明」に寄せる。
    const undecidable = new Map();   // path → 理由
    // 情報セクションは `<パス数> NUL <path>... NUL <衝突の種類> NUL <メッセージ>` の並び。
    // ⚠️ メッセージ本文（`Failed to merge submodule mod`）に頼ると取りこぼす。
    //    親の作業ツリーに submodule が展開されていない構成では
    //    そのメッセージが出ず、種類だけが `CONFLICT (submodule)` になる（実測）。
    //    **構造として読んで種類で判定する。**
    const rec = parts.slice(i + 1);
    for (let k = 0; k < rec.length;) {
        const count = Number(rec[k]);
        if (!Number.isInteger(count) || count < 1 || count > 64) { k++; continue; }
        const paths = rec.slice(k + 1, k + 1 + count).map(toNFC);
        const kind = rec[k + 1 + count] ?? '';
        // 🚨 **退避名は構造から取る。メッセージ本文に頼ると取りこぼす。**
        //    `CONFLICT (file/directory)` は `moving it to X instead` と言うが、
        //    `CONFLICT (distinct types)`（symlink 対 file）は**言わない**:
        //      `link had different types on each side; renamed one of them
        //       so each can be recorded somewhere.`
        //    そのため symlink 対 file の合成パスが印無しで出ていた（#1 の見落とし。
        //    回帰テストを足して初めて分かった）。
        //    どちらも**2パスの情報レコード**で、一方が `<実体>~<接尾辞>` の形になる。
        //    ⚠️ **順序は種類によって逆**（file/directory は 合成→実体、
        //       distinct types は 実体→合成）。順序に依存せず形で決める。
        if (count === 2) {
            const [p, q] = paths;
            if (p.startsWith(`${q}~`)) synthetic.set(p, q);
            else if (q.startsWith(`${p}~`)) synthetic.set(q, p);
        }
        if (/submodule/i.test(kind)) {
            for (const p of paths) {
                undecidable.set(p,
                    'submodule はマージを試せません（git が trivial なケースだけ対応）');
            }
        }
        k += count + 3;   // 件数 + パス群 + 種類 + メッセージ
    }
    // メッセージ本文からも拾う（構造が変わったときの保険）
    for (const m of info.matchAll(/Failed to merge submodule (.+?)(?:\n|$)/g)) {
        const p = toNFC(m[1].trim());
        if (!undecidable.has(p)) {
            undecidable.set(p, 'submodule はマージを試せません（git が trivial なケースだけ対応）');
        }
    }
    // 実体を取れなかったが hint はある場合も「不明」に倒す
    const trivialOnly = /only supports trivial cases/i.test(r.stderr ?? '');
    return {
        clean: false, conflicts, synthetic, undecidable, trivialOnly,
        info: info.trim() || null,
    };
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
        // 🚨 `sequencer/todo` を見ないと取りこぼす。
        //    `git cherry-pick A B` が衝突し、`--continue` ではなく**手で commit** すると
        //    CHERRY_PICK_HEAD は消えるのに `sequencer/todo` に残りの pick が居座る。
        //    その状態で checkout して `--continue` すると**残りが切り替え先に乗る**
        //    （レビューで実証。まさにこのツールが警告している乗っ取りと同じ結果）。
        sequencing: existsSync(p('sequencer/todo')),
        sequencerTodo: read('sequencer/todo'),
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
    // 🚨 CHERRY_PICK_HEAD/REVERT_HEAD が消えていても sequencer は残る。
    //    フラグだけ見ていると「何も進行していない」ように見えるのが危険。
    if (state.sequencing && !state.cherryPicking && !state.reverting && !state.rebasing) {
        const rest = (state.sequencerTodo ?? '').split('\n').filter(Boolean);
        state.warnings.push({
            level: 'danger',
            code: 'sequencer-todo-left',
            message: `sequencer に未処理の操作が ${rest.length} 件残っている`
                + `（${rest.slice(0, 2).join(' / ')}${rest.length > 2 ? ' …' : ''}）。`
                + ' CHERRY_PICK_HEAD / REVERT_HEAD は消えているので一見何も進行していないが、'
                + 'この状態で checkout して --continue すると残りが切り替え先にリプレイされる。'
                + ' 先に --continue か --quit で決着させること。',
        });
    }
    return state;
}
