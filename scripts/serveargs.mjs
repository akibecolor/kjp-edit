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

/** 起動口が受け付けるフラグ。ここに無いものは黙って捨てずに止める */
export const SERVE_FLAGS = new Set(['--repo', '--port', '--write', '--exec', '--allow-host',
    '--watch', '--agents-text', '--status', '--stop', '--help', '-h']);

/** 自動起動の登録が受け付けるフラグ（`--status` 等はサブコマンドなので入らない） */
export const AUTOSTART_FLAGS = new Set(['--repo', '--port', '--write', '--exec', '--allow-host',
    '--watch', '--agents-text']);

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
export const VALUE_FLAGS = new Set(['--repo', '--port', '--allow-host']);

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
 * `v0/server.mjs` に渡す argv を組む。
 *
 * 🔒 ここが capability の分界。**`--exec` は `--write` を含むが、逆は含まない。**
 *    観測（`--watch` / `--agents-text`）はどちらとも独立で、既定では付けない。
 */
export function serverArgs({
    argv, server, repo, port, tokenFile, writeTokenFile, execTokenFile, auditLog,
}) {
    const has = f => argv.includes(f);
    const args = [server, '--repo', repo, '--port', String(port)];
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
    if (wantExec) {
        args.push('--allow-exec');
        if (auditLog) args.push('--audit-log', auditLog);
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
export function autostartServeArgs({ argv, repo, port }) {
    const has = f => argv.includes(f);
    const args = ['--repo', repo, '--port', String(port)];
    if (has('--exec')) args.push('--exec');
    else if (has('--write')) args.push('--write');
    const hosts = collectHosts(argv);
    if (hosts.error !== undefined) return { error: hosts.error };
    for (const h of hosts.hosts) args.push('--allow-host', h);
    if (has('--agents-text')) args.push('--agents-text');
    else if (has('--watch')) args.push('--watch');
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

/** 人が読む形にする（`--status` と「既に動いています」で同じ言い方をする） */
export function describeCaps(cmd) {
    const caps = runningCaps(cmd);
    const parts = [];
    if (caps.includes('--allow-exec')) parts.push('🚨 実行（任意コマンド）');
    else if (caps.includes('--allow-write')) parts.push('書き込み（checkout）');
    else parts.push('読み取り専用');
    if (caps.includes('--allow-transcript-text')) parts.push('活動観測+発話');
    else if (caps.includes('--watch-agents')) parts.push('活動観測');
    const hosts = [...String(cmd ?? '').matchAll(/--allow-host\s+(\S+)/g)].map(m => m[1]);
    parts.push(hosts.length ? `Host許可: ${hosts.join(', ')}` : 'ループバックのみ');
    return parts.join(' / ');
}
