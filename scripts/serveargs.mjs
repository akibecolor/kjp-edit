// SPDX-License-Identifier: MIT
//
// 起動口（`serve.mjs`）と自動起動の登録（`autostart.mjs`）が作る **argv を純関数にする**。
//
// なぜ切り出すか（#45）:
//   これらの門は全部「実行して確かめるテストが無い」状態だった —
//   未知フラグの拒否（#30）、`--port` の範囲、`--allow-host` と観測フラグの引き継ぎ
//   （c0948ea = **再起動後だけ 403 / ログオン後だけパネルが消える**）。
//   引き継ぎのループを消しても `verify.mjs` は緑のまま通っていた。
//   **落ちない検査は無意味**（CLAUDE.md）なので、配線を関数にして固定する。
//
// ⚠️ ここは**起動前**に走るので、`v0/` のモジュールに依存しない（サーバを読み込まない）。

// ⚠️ `winargs.mjs` も純関数だけ（`v0/` には触らない）。`--stop` の対象を repo で絞るのに使う
import { repoOf, reposOf, samePathish } from './winargs.mjs';

/** 起動口が受け付けるフラグ。ここに無いものは黙って捨てずに止める */
export const SERVE_FLAGS = new Set(['--repo', '--port', '--write', '--exec', '--allow-host',
    '--watch', '--agents-text', '--timeout', '--status', '--stop', '--all', '--help', '-h']);

/** 自動起動の登録が受け付けるフラグ（`--status` 等はサブコマンドなので入らない） */
export const AUTOSTART_FLAGS = new Set(['--repo', '--port', '--write', '--exec', '--allow-host',
    '--watch', '--agents-text', '--timeout',
    // 🚨 検査専用: レジストリに触る手前で止める（#74 の門を変異で測るため）
    '--dry-run']);

/**
 * サーバ側の名前 → この層での名前。
 * 🚨 **「知らない」で終わらせず正しい名前を出す。** サーバの名前で打たれることが多く、
 *    無視すると「打ったのに効かない」が起動するまで分からない（#30）。
 */
export const FLAG_ALIAS = {
    '--allow-write': '--write',
    '--allow-exec': '--exec',
    '--watch-agents': '--watch',
    '--allow-transcript-text': '--agents-text',
};

/** 値を取るフラグ。次のトークンは値なので、フラグとして検査してはいけない */
export const VALUE_FLAGS = new Set(['--repo', '--port', '--allow-host', '--timeout']);

/**
 * 未知のフラグを探す。見つからなければ null。
 *
 * ⚠️ **値を飛ばす。** `--port -1` の `-1` を「知らないオプション」として
 *    報告すると、本当の原因（範囲外）から目を逸らさせる。
 */
export function unknownFlag(argv, known = SERVE_FLAGS, label = 'この起動口') {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (VALUE_FLAGS.has(a)) { i++; continue; }
        if (!a.startsWith('-') || known.has(a)) continue;
        const hint = FLAG_ALIAS[a] ? `（${label}では ${FLAG_ALIAS[a]} です）` : '';
        return { flag: a, hint, known: [...known] };
    }
    return null;
}

/** `--port` を検証する。`{ port }` か `{ error }` を返す（黙って既定に落とさない） */
export function checkPort(raw, def) {
    if (raw === undefined || raw === null || raw === '') return { port: Number(def) };
    // ⚠️ `Number('7749abc')` は NaN だが `Number(' 7749 ')` は通る。
    //    Run キーに入る文字列なので、桁だけに限る
    if (!/^\d+$/.test(String(raw))) return { error: String(raw) };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: String(raw) };
    return { port: n };
}

/**
 * `--timeout <秒>` を検証する（実行セッションの絶対上限）。
 *
 * 🚨 **既定の 600 秒はエージェントの仕事に足りない。** 実測で「issue を洗って
 *    優先度を付ける」が Bash/Read を20回して 551 秒の時点でまだ走っていた
 *    （もう少しで SIGKILL されて回答が消えるところだった）。
 * ⚠️ **上限そのものは消せない形にする。** これは取り残しの唯一の歯止めなので、
 *    「無制限」は受け付けず、値を明示して延ばすだけにする。
 * @returns {{seconds: number|null} | {error: string}} 指定が無ければ seconds: null
 */
export function checkTimeout(raw) {
    if (raw === undefined || raw === null || raw === '') return { seconds: null };
    if (!/^\d+$/.test(String(raw))) return { error: String(raw) };
    const n = Number(raw);
    // 下限 10 秒（打ち間違いで即殺す状態を作らない）/ 上限 24 時間
    if (!Number.isFinite(n) || n < 10 || n > 86400) return { error: String(raw) };
    return { seconds: n };
}

/**
 * argv から `--timeout <秒>` を取り出して検証する。
 *
 * 🚨 **値が無い形を黙って既定に落とさない。** `serve.mjs --exec --timeout`（値を忘れた）や
 *    `--timeout --allow-host box` は、打った本人は上限を延ばしたつもりなのに
 *    **600 秒のまま起動する**（`val()` が次のトークンを取れないと既定に落ちるため）。
 *    「打ったフラグを黙って捨てない」（#30）を値の側でも守る。
 * @returns {{seconds: number|null} | {error: string}} 指定が無ければ seconds: null
 */
export function timeoutFrom(argv) {
    const a = Array.isArray(argv) ? argv : [];
    const i = a.indexOf('--timeout');
    if (i === -1) return { seconds: null };
    const raw = a[i + 1];
    // ⚠️ 次がフラグなら値ではない（`--timeout --exec` を 0 秒や既定と読まない）
    if (raw === undefined || String(raw).startsWith('-')) return { error: raw ?? '(無し)' };
    return checkTimeout(raw);
}

/**
 * `--allow-host` の値を検証する。
 *
 * 🚨 **起動口と自動起動で同じ検証にする。** 片方だけ検証していない非対称が
 *    #29 の原因だった（`--allow-host` は検証し、`--repo` は無検証だった）。
 *    Run キーの値は1つの文字列なので、空白や引用符が混ざると別の引数に化ける。
 */
export function checkHost(h) {
    if (!h || !/^[A-Za-z0-9._-]+$/.test(h)) return { error: h ?? null };
    return { host: h };
}

/** argv から `--allow-host` の値を全部集める（検証込み）。`{ hosts }` か `{ error }` */
export function collectHosts(argv) {
    const hosts = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--allow-host') continue;
        const r = checkHost(argv[i + 1]);
        if (r.error !== undefined) return { error: r.error };
        hosts.push(r.host);
    }
    return { hosts };
}

/**
 * argv から `--repo` の値を全部集める。
 *
 * 🚨 **`--allow-host` と同じ扱いにする。** 1本目だけ読んで残りを捨てると、
 *    「2本目のリポジトリが一覧に出ない」が起動するまで分からない（#30 の形）。
 * ⚠️ 空・引用符・改行は弾く。Run キーの値は**1つの文字列**なので、
 *    これらが混ざると別の引数に化ける（#29 と同じ根拠。`autostart.mjs` が
 *    `--repo` 1本にだけ掛けていた検証を、全部に掛ける）。
 * @returns {{repos: string[]} | {error: string|null}} 指定が無ければ repos: []
 */
export function collectRepos(argv) {
    const repos = [];
    const a = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== '--repo') continue;
        const v = a[i + 1];
        if (!v || v.startsWith('-') || /["\r\n\0]/.test(v)) return { error: v ?? null };
        repos.push(v);
    }
    return { repos };
}

/**
 * `v0/server.mjs` に渡す argv を組む。
 *
 * 🔒 ここが capability の分界。**`--exec` は `--write` を含むが、逆は含まない。**
 *    観測（`--watch` / `--agents-text`）はどちらとも独立で、既定では付けない。
 */
export function serverArgs({
    argv, server, repos, port, tokenFile, writeTokenFile, execTokenFile, auditLog,
    execTimeout = null,
}) {
    const has = f => argv.includes(f);
    // ⚠️ **配列を要求する。** 以前の `repo`（単数）を渡すと `--repo undefined` に
    //    なって「起動したのに別の場所を見ている」で気付くことになるので、
    //    黙って通さず throw する（呼び出し側の取り違えを起動前に止める）。
    if (!Array.isArray(repos) || repos.length === 0) {
        throw new TypeError('serverArgs には repos（1本以上の配列）を渡してください');
    }
    const args = [server];
    // 🔒 読める範囲。**1本目が既定**なので順序を保つ
    for (const r of repos) args.push('--repo', r);
    args.push('--port', String(port));
    const wantExec = has('--exec');
    const wantWrite = wantExec || has('--write');
    if (wantWrite) args.push('--allow-write');

    const hosts = collectHosts(argv).hosts ?? [];
    // 🚨 **読み取り用と実行用でトークンのファイルを分ける。**
    //    以前は同じ `~/.kjp-edit/token` を両方に渡していたので、
    //    `serve.mjs --allow-host box.ts.net`（読み取り専用）が案内する `?token=…` は
    //    `serve.mjs --exec` のデーモンが受け付ける値と**バイト一致**していた。
    //    つまり「スマホで読み取り用の URL を1回開く」ことが、
    //    **実行トークンを携帯のブラウザ・URL 履歴・トンネルのログに置く**ことと同義だった
    //    （Cookie に実行トークンを入れていたのと同じクラスの再発。今回は自分の別デーモン宛。
    //     6回目のレビュー）。**capability ごとに別の資格情報にする。**
    // 🔒 `--allow-host` を付けると読み取りにも認証が要る。トークンが起動ごとに
    //    変わると開き直すたびに URL を探すので、トンネルを使うなら必ず永続化する。
    // 🚨 **3段にする（read / write / exec）。** 6回目に分けたのは exec だけだったので、
    //    `--write --allow-host` のデーモンは読み取り専用トンネルと**同じ token-read** を
    //    使っていた。読み取り用として配った（スマホの履歴・ブックマーク・トンネルの
    //    アクセスログに残した）トークンが、書き込みデーモンでは
    //    `POST /api/v0/checkout` の資格情報になる。**分界は資格情報のレベルでも引く**
    //    （7回目のレビュー。しかもテストが「--write は起動ごとのランダムで足りる」と
    //     書いてこの組み合わせを承認していた）。
    const file = wantExec ? execTokenFile : (wantWrite ? writeTokenFile : tokenFile);
    if ((hosts.length > 0 || wantExec) && file) args.push('--token-file', file);
    // 🚨 **監査ログの置き場所は capability に関係なく渡す**（8回目のレビュー）。
    //    以前は `--exec` のときだけ渡していたので、常用構成（読み取り専用 +
    //    `--allow-host`）では**認証失敗の記録を移す手段が無く**、自分の `.git` の中に
    //    無認証で書かれ続けた（トンネルに出している間、tailnet の全端末から撃てる）。
    //    401 を記録するのは `--require-auth` を付けた瞬間からなので、
    //    「実行を許したときだけ記録が出る」という前提が既に成り立っていない。
    if (auditLog) args.push('--audit-log', auditLog);
    if (wantExec) {
        args.push('--allow-exec');
        // 🚨 **絶対上限を起動口から延ばせるようにする。**
        //    既定 600 秒はエージェントの仕事に足りない（実測: Bash/Read を20回する
        //    「issue を洗って優先度を付ける」が 551 秒の時点でまだ走っていた）。
        //    ⚠️ 上限そのものは消さない。**取り残しの唯一の歯止め**なので、
        //    値を明示して延ばす形にする（`serve.mjs --exec --timeout 3600`）。
        //    値の検証は呼び出し側（`checkTimeout`）。ここは組み立てるだけ。
        if (execTimeout !== null && execTimeout !== undefined) {
            args.push('--exec-timeout', String(execTimeout));
        }
    }
    for (const h of hosts) args.push('--allow-host', h);

    // ⚠️ **`--agents-text` は `--watch-agents` を含む。** サーバ側が
    //    `--allow-transcript-text` 単独を「観測も有効」と読むかに依存させない
    //    （依存させると、サーバの既定が変わった日に**黙ってパネルが消える**）。
    if (has('--agents-text')) args.push('--watch-agents', '--allow-transcript-text');
    else if (has('--watch')) args.push('--watch-agents');
    return args;
}

/**
 * 自動起動の Run キーに入れる `serve.mjs` の引数を組む。
 *
 * ⚠️ **引き継ぎを落とすと「再起動後だけ壊れる」形になる。** 手元では気付けない
 *    （`--allow-host` を落として**スマホから見たときだけ 403**、
 *      観測フラグを落として**ログオン後だけパネルが消える**）。
 */
export function autostartServeArgs({ argv, repos, port }) {
    const has = f => argv.includes(f);
    // 🚨 **リポジトリの本数も引き継ぐ。** 落とすと**再起動後だけ1本に戻る**ので、
    //    「朝は2本見えていたのに、ログオンし直したら1本になっている」という
    //    手元では絶対に気付けない壊れ方になる（`--allow-host` / `--timeout` と同型）。
    if (!Array.isArray(repos) || repos.length === 0) {
        throw new TypeError('autostartServeArgs には repos（1本以上の配列）を渡してください');
    }
    const args = [];
    for (const r of repos) args.push('--repo', r);
    args.push('--port', String(port));
    if (has('--exec')) args.push('--exec');
    else if (has('--write')) args.push('--write');
    const hosts = collectHosts(argv);
    if (hosts.error !== undefined) return { error: hosts.error };
    for (const h of hosts.hosts) args.push('--allow-host', h);
    if (has('--agents-text')) args.push('--agents-text');
    else if (has('--watch')) args.push('--watch');
    // 🚨 **絶対上限も引き継ぐ。** 落とすと**再起動後だけ 600 秒に戻る**ので、
    //    「同じ仕事が朝は完走したのに夕方は途中で殺される」になる（#45 と同型）
    const i = argv.indexOf('--timeout');
    if (i !== -1) {
        const t = checkTimeout(argv[i + 1]);
        if (t.error !== undefined) return { error: t.error };
        if (t.seconds !== null) args.push('--timeout', String(t.seconds));
    }
    return { args };
}

/**
 * 動いているデーモンのコマンド行から capability を読む。
 *
 * 🚨 **「既に動いています」で URL だけ出してはいけない。** 先に `--exec` の
 *    デーモンが動いていると、素の `node scripts/serve.mjs`（読み取り専用のつもり）が
 *    「既に動いています → URL」と出して exit 0 し、**案内した先が RCE 可能な
 *    デーモンであることを1文字も言わなかった**（7回目のレビュー）。
 * @param {string} cmd 動いているプロセスのコマンド行
 * @returns {string[]} サーバ側のフラグ名
 */
export function runningCaps(cmd) {
    // ⚠️ 正規表現でコマンド行を舐めない。`--allow-host` が `--allow-hostx` にも
    //    当たるし、テンプレートリテラルの中で `\s` が潰れて `s` になる事故もある
    //    （実際に踏んだ）。**空白で切ってトークンとして比べる。**
    const tokens = new Set(String(cmd ?? '').split(/\s+/));
    return ['--allow-exec', '--allow-write', '--watch-agents', '--allow-transcript-text',
        '--allow-host'].filter(f => tokens.has(f));
}

/** この起動口の argv が要求している capability（サーバ側のフラグ名に直して返す） */
export function requestedCaps(argv) {
    const a = Array.isArray(argv) ? argv : [];
    const out = [];
    if (a.includes('--exec')) { out.push('--allow-exec', '--allow-write'); }
    else if (a.includes('--write')) out.push('--allow-write');
    if (a.includes('--agents-text')) out.push('--watch-agents', '--allow-transcript-text');
    else if (a.includes('--watch')) out.push('--watch-agents');
    if (a.includes('--allow-host')) out.push('--allow-host');
    return out;
}

/**
 * 動いているデーモンのコマンド行から**値まで含む設定**を読む。
 *
 * 🚨 **名前の集合だけ比べると、値を持つフラグが黙って無効になる**（8回目のレビュー）。
 *    `--timeout 3600` を付けて起動し直したつもりが「既に動いています」で exit 0 になり、
 *    前のデーモンが 600 秒のまま走り続けていた（`--timeout` を足した理由そのものが消える。
 *    実測で 551 秒でまだ走っていた仕事が、この経路で無言で旧設定に戻る）。
 *    `--allow-host box-b` も同じで、動いているのが box-a なら**スマホからは 403 のまま**
 *    （c0948ea の「再起動後だけ 403」と同型）。
 * @param {string} cmd 動いているプロセスのコマンド行
 * @returns {{caps: string[], hosts: string[], execTimeout: number|null}}
 *   execTimeout は `--exec-timeout` が無ければ null（= サーバの既定 600 秒）
 */
export function runningConfig(cmd) {
    // ⚠️ 正規表現でコマンド行を舐めない（`--allow-hostx` に当たる）。値は**次のトークン**。
    //    ホスト名と秒数は空白を含みえないので、空白で切って読めば足りる。
    const tokens = String(cmd ?? '').split(/\s+/);
    const hosts = [];
    let execTimeout = null;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '--allow-host' && tokens[i + 1]) hosts.push(tokens[i + 1]);
        else if (tokens[i] === '--exec-timeout' && /^\d+$/.test(tokens[i + 1] ?? '')) {
            execTimeout = Number(tokens[i + 1]);
        }
    }
    // 🚨 リポジトリは**空白を含みえる**（`--repo "C:/Users/a b/repo"`）ので、
    //    空白で切るこのループでは読めない。引用を解する `reposOf()` を使う
    //    （`(\S+)` で取ると `"C:/Users/a` までしか取れない。#31 と同じ罠）。
    return { caps: runningCaps(cmd), hosts, execTimeout, repos: reposOf(cmd) };
}

/**
 * この起動口の argv が要求している設定（値まで）。
 *
 * ⚠️ `--allow-host` は**名前ではなく値**で比べる（名前だけだと box-a と box-b が同じに見える）。
 * ⚠️ `--exec` が無ければ上限はサーバに渡らない（`serverArgs` が付けない）ので、
 *    要求として数えない。数えると「読み取り専用のつもりの起動」が毎回差分で止まる。
 */
export function requestedConfig(argv) {
    const a = Array.isArray(argv) ? argv : [];
    const caps = requestedCaps(a).filter(c => c !== '--allow-host');
    const t = a.includes('--exec') ? timeoutFrom(a) : { seconds: null };
    return {
        caps,
        hosts: collectHosts(a).hosts ?? [],
        execTimeout: t.seconds ?? null,
    };
}

/**
 * 要求した設定と、動いているデーモンの設定の差分。
 *
 * 🚨 **空なら「打ったものは全部効いている」と言えること**が、この関数の約束。
 *    以前は capability の**名前**しか比べていなかったので、`--timeout` は集合に入らず
 *    `--allow-host` は値を見ず、`missing=[]` で exit 0 = **黙って無効**だった。
 * @returns {{what: string, want: string, have: string}[]} 空なら差分なし
 */
export function configDiff(argv, cmd, { repos = null } = {}) {
    const req = requestedConfig(argv);
    const run = runningConfig(cmd);
    const diffs = [];
    // 🚨 **要求したリポジトリが全部見えているか。** 二重起動の判定は1本目で
    //    しているので、これが無いと `--repo A --repo B` を打った人に
    //    「既に動いています（A のデーモン）」と答えて exit 0 してしまい、
    //    **B が見えないことを1文字も言わない**（`--timeout` と同型の穴）。
    // ⚠️ 呼び出し側は**解決済み**のパスを渡すこと（argv の生の値は
    //    デーモン側の絶対パスと一致しない）。渡されなければ比べない。
    for (const r of (Array.isArray(repos) ? repos : [])) {
        if (!run.repos.some(x => samePathish(x, r))) {
            diffs.push({
                what: '--repo',
                want: r,
                have: run.repos.length ? run.repos.join(', ') : '(不明)',
            });
        }
    }
    for (const c of req.caps) {
        if (!run.caps.includes(c)) diffs.push({ what: c, want: '有効', have: '無効' });
    }
    // ⚠️ ホスト名は大文字小文字を区別しない（DNS 名なので）
    const low = s => String(s).toLowerCase();
    for (const h of req.hosts) {
        if (!run.hosts.some(x => low(x) === low(h))) {
            diffs.push({
                what: '--allow-host',
                want: h,
                have: run.hosts.length ? run.hosts.join(', ') : 'ループバックのみ',
            });
        }
    }
    // 値が違えば差分。**長い方に丸めない**（打った値が効いていないことは事実）
    if (req.execTimeout !== null && req.execTimeout !== run.execTimeout) {
        diffs.push({
            what: '--exec-timeout',
            want: `${req.execTimeout} 秒`,
            have: run.execTimeout === null ? 'サーバ既定（600 秒）' : `${run.execTimeout} 秒`,
        });
    }
    return diffs;
}

/**
 * `--stop` が止める対象を選ぶ。
 *
 * 🚨 **既定はカレントのリポジトリだけにする**（8回目のレビュー）。以前は
 *    「node.exe で cmdline に v0/server.mjs を含むもの」を全部 `taskkill /T /F` していた。
 *    `/T` なので走っている exec の子（`claude -p` / `npm test`）も死ぬのに、
 *    出力は PID と port だけで**どのリポジトリを止めたかを一言も言わなかった**。
 *    N 個のエージェントを並行で回す前提のツールで、repo A の作業を終えて `--stop` を打つと
 *    **repo B で 8 分走っている会話セッションが無言で消える**。
 *    マシン上の全部を止めるのは `--stop --all` で明示させる。
 * 🚨 **「別のリポジトリ」と「分からない」を分ける（9回目のレビュー / #54）。**
 *    以前は `repoOf()` が null（コマンド行から repo を読めなかった）でも
 *    `others` に入れて **「← 別のリポジトリなので止めません」と断言**していた。
 *    実際には**分からない**だけなので、止め残しに気付けない。
 *    「分からないなら分からないと言う」（#31 / `running()` の `{supported, …}`）を、
 *    同じファイルの表示側が破っていた。
 * @param {{pid:number, port:number|null, cmd:string}[]} list
 * @param {string|null} repo カレントのリポジトリ（`all` のときは見ない）
 * @returns {{targets: object[], others: object[], unknown: object[]}}
 *   others = 別のリポジトリだと**分かっている**もの / unknown = 判定できなかったもの。
 *   どちらも止めないが、**言い方を変える**（必ず両方見せる）
 */
/**
 * 🚨 **そのデーモンが「このリポジトリ」を配信しているか（#61。10回目のレビュー / BLOCKING）。**
 *
 * `--repo` は複数指定できるのに、対象の判定が全部 `repoOf()`（**1本目だけ**）だった。
 * その結果、`--repo A --repo B` で動いているデーモンに対して repo B で:
 *
 * - `--stop` が「このリポジトリの kjp-edit は動いていません: B」と言い、
 *   続けて「← 別のリポジトリなので止めません」と**断言**した。
 *   実際にはそのデーモンが B を配信していて、`--exec` の子ごと生き残る
 *   （CLAUDE.md が「観測ツールとして最悪の誤り」と呼ぶ**止めたつもりで走り続けている**）
 * - 二重起動の門が外れ、B を見る2本目が黙って立ち上がる
 *   （watcher・TTL キャッシュ・実行枠・監査ログが二重になる）
 *
 * ⚠️ **「読めなかった」と「別のリポジトリ」を混ぜない。** 一覧が空なら null を返し、
 *    呼ぶ側が `unknown` として扱う（#54 で分けたのと同じ理由）。
 * @returns {boolean|null} 一致すれば true / しなければ false / 判定できなければ null
 */
export function servesRepo(cmd, repo) {
    const list = reposOf(cmd);
    if (!list || !list.length) return null;
    return list.some(r => samePathish(r, repo));
}

export function stopTargets(list, repo, all = false) {
    const items = Array.isArray(list) ? list : [];
    if (all) return { targets: items, others: [], unknown: [] };
    const targets = [];
    const others = [];
    const unknown = [];
    for (const r of items) {
        // 🚨 **1本目だけで判定しない（#61）。** `--repo` は複数指定できるので、
        //    「登録済みのどれか1本でも一致したら自分のデーモン」。
        const serves = servesRepo(r?.cmd, repo);
        // ⚠️ 順序が意味を持つ: 「読めなかった」を先に分ける。
        //    後ろに回すと false と同じ扱いになって「別のリポジトリ」に混ざる（#54 の形）。
        if (serves === null) unknown.push(r);
        else if (serves) targets.push(r);
        else others.push(r);
    }
    return { targets, others, unknown };
}

/**
 * `--stop` の結末を決める（純関数にして「調べられない」を測れるようにする）。
 *
 * 🚨 **「調べられない」を「止まりました」と読まない。** 数え直しは
 *    `const left = after.supported ? … : []` だったので、2回目の PowerShell が失敗すると
 *    `left=[]` → **何も言わずに exit 0**。「調べられない」を「無い」と言わないために
 *    30 行上で潰した #31 と同型の穴が、同じ関数の中に残っていた（8回目のレビュー）。
 * @param {{after: {supported: boolean, list?: object[]}, targets: object[], failed?: number}} o
 * @returns {{exit: number, unknown: boolean, left: number[]}}
 */
export function stopOutcome({ after, targets, failed = 0 }) {
    if (!after?.supported) return { exit: 1, unknown: true, left: [] };
    const t = Array.isArray(targets) ? targets : [];
    const left = (after.list ?? []).filter(r => t.some(x => x.pid === r.pid)).map(r => r.pid);
    return { exit: left.length || failed ? 1 : 0, unknown: false, left };
}

/** 人が読む形にする（`--status` と「既に動いています」で同じ言い方をする） */
export function describeCaps(cmd) {
    const { caps, hosts, execTimeout } = runningConfig(cmd);
    const parts = [];
    if (caps.includes('--allow-exec')) parts.push('🚨 実行（任意コマンド）');
    else if (caps.includes('--allow-write')) parts.push('書き込み（checkout / 編集）');
    else parts.push('読み取り専用');
    // 🚨 **実行の絶対上限を必ず出す。** ここは「何が有効か」を確認する唯一の手段で、
    //    上限は**投げた仕事が完走するか**を決める。出さないと
    //    `--timeout 3600` を打ったのに 600 秒のデーモンに案内されたことが分からない。
    if (caps.includes('--allow-exec')) {
        parts.push(execTimeout === null ? '上限 サーバ既定（600秒）' : `上限 ${execTimeout}秒`);
    }
    if (caps.includes('--allow-transcript-text')) parts.push('活動観測+発話');
    else if (caps.includes('--watch-agents')) parts.push('活動観測');
    parts.push(hosts.length ? `Host許可: ${hosts.join(', ')}` : 'ループバックのみ');
    return parts.join(' / ');
}

/**
 * 🚨 **他に動いているデーモンを黙らせない（9回目のレビュー / #55）。**
 *
 * 二重起動の門は「同じリポジトリ」だけを見るので、別のリポジトリの2本目は
 * **正しく**立ち上がる。ただし今まで一言も言わなかったので、
 * 「今マシン上で何本動いているか」を `--status` を打つまで知る手段が無かった
 * （N 個のエージェントを並行で回す前提のツールで、実行枠と監査が別々に増える）。
 *
 * ⚠️ **「調べられない」を「0 本」と言わない**（`running()` と同じ型）。
 * @param {{supported: boolean, list?: object[]}} probe `running()` の戻り
 * @param {string|null} repo これから見るリポジトリ（自分と同じものは数えない）
 * @returns {{count: number, lines: string[]} | null} 言うことが無ければ null
 */
export function otherDaemonsNote(probe, repo) {
    if (!probe?.supported) return null;
    // 🚨 複数 repo のデーモンを「他のリポジトリ」と数えない（#61）
    const others = (probe.list ?? []).filter(r => servesRepo(r?.cmd, repo) !== true);
    if (!others.length) return null;
    return {
        count: others.length,
        lines: others.map(r => `PID ${r.pid}  port ${r.port ?? '?'}  `
            + `${describeCaps(r.cmd)}  ${(reposOf(r.cmd) ?? []).join(' , ') || '(repo 不明)'}`),
    };
}

/**
 * 🚨 **ポートが動いたら、トンネルの向き先も動いたことを言う（#55）。**
 *
 * `--allow-host` はトンネル越しに使うためのフラグで、トンネル（`tailscale serve`）は
 * **固定のポート**を指している。ポートが空きに移ると母艦では正常に見えるのに
 * **スマホからだけ繋がらない**（`--allow-host` を渡し忘れたときと同じ壊れ方で、
 * 手元では絶対に気付けない）。
 *
 * @param {{from: number, to: number, hosts: string[]}} o
 * @returns {string[]} 追加で出す行（言うことが無ければ空）
 */
export function portShiftNote({ from, to, hosts }) {
    if (!Array.isArray(hosts) || !hosts.length) return [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return [];
    return [
        `🚨 トンネルの向き先が ${from} のままだと、スマホからは繋がりません`
        + `（Host許可: ${hosts.join(', ')}）。`,
        `  向き先を ${to} に変えてください: tailscale serve --bg ${to}`,
        `  戻すなら: node scripts/serve.mjs --stop --repo <path> して ${from} が空いてから起動`,
    ];
}

/**
 * 🚨 **`token-read` に派生秘密を書き戻してよいか（#59 の回帰。10回目のレビュー / SERIOUS）。**
 *
 * `--exec` / `--write` のときサーバに渡すのは実行（書き込み）トークンなので、
 * 読み取りとして通るのは**そこから派生した秘密**だけ。だから `token-read` には
 * その派生値を書く必要がある（書かないと「読み取り用」と名乗るファイルで読めない）。
 *
 * ⚠️ **読み取り専用のときは書いてはいけない。** その構成では `--token-file` に
 *    渡すのが `token-read` **そのもの**なので、読んで派生させて同じファイルに
 *    書き戻すと、**起動のたびに鍵が回る**（`token-read` → `f(token-read)` →
 *    `f(f(token-read))` …）。`--token-file` で固定できると告知しながら、
 *    スマホのブックマークが再起動のたびに 401 になる。
 *
 * @param {string|null} tokenFile サーバに `--token-file` で渡すファイル
 * @param {string} readFile `~/.kjp-edit/token-read`
 * @returns {boolean} 派生秘密を readFile に書くべきなら true
 */
export function shouldWriteReadSecret(tokenFile, readFile) {
    if (!tokenFile || !readFile) return false;
    // 区切り文字と大文字小文字の違いだけで「別ファイル」と誤判定しない
    const norm = s => s.split(String.fromCharCode(92)).join('/')
        .replace(/\/+$/, '').toLowerCase();
    return norm(tokenFile) !== norm(readFile);
}
