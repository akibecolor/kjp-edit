#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 突然変異テスト。**「守っている」と主張するコードを1つずつ外して、
// 対応するテストが実際に落ちるかを確かめる。**
//
//   node scripts/mutate.mjs            # 全件
//   node scripts/mutate.mjs <name>...  # 指定したものだけ
//   node scripts/mutate.mjs --list
//
// なぜ必要か（実際に2件の偽陽性を作った。docs/review-write-exec.md）:
//   - `core.fsmonitor` のテストはフックのクォート不足で起動しておらず、
//     修正を外しても緑だった
//   - `pathspec magic` のテストは入口の検証しか見ておらず、
//     git フラグを外しても緑だった
//   **落ちない検査は無意味。** テストを足したらここに変異も足す。
//
// ⚠️ process.exit() を try の中で使わない。finally を飛ばして
//    書き換えたソースが復元されないまま残る（実際に修正を1行失った）。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);

/**
 * 各変異は「守りを外す書き換え」と「それを捕まえるべきテスト」の対。
 * gone: 書き換えが効いたことを確かめる文字列（消えていれば成功）。
 *   ⚠️ コメント中に同じ語が出る場合は引数の形で書く。
 *      そうしないと「置換が効いていない」と誤判定する（実際に踏んだ）。
 */
const MUTANTS = [
    {
        name: 'input-eats-ring',
        why: '長い入力の本文をリングに積む（自分の貼り付けで子の出力が全部押し出され、最後の出力が消える）',
        file: 'v0/execsession.mjs',
        from: "        if (t === 'in' && typeof d === 'string' && d.length > IN_KEEP_CHARS) {",
        to: '        if (false) {   /* 変異: 入力もそのまま積む */',
        gone: "if (t === 'in' && typeof d === 'string' && d.length > IN_KEEP_CHARS) {",
        pattern: '長い入力はリングに本文を残さない',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        // ⚠️ MINOR: merge の bare 門は検査があるのに変異が無かった
        //    （prunable だけ後から足されていた）
        name: 'merge-bare-gate',
        why: '作業ツリーの無い bare に取り込む（checkout と同じ門を後から足したのに変異が無かった）',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では取り込めません'); return; }\n"
            + "            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }",
        to: "            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }",
        gone: "'bare worktree では取り込めません'",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'recent-dropped-silent',
        why: '直近の活動を切ったことを数えない（12件で切っているのに「これで全部」に見える）',
        file: 'v0/transcript.mjs',
        from: '                if (out.recent.length >= limits.maxRecent) { out.recentDropped++; continue; }',
        to: '                if (out.recent.length >= limits.maxRecent) continue;   /* 変異: 黙って切る */',
        gone: 'out.recentDropped++',
        pattern: '直近の活動を切ったら件数を返す',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'clock-skew-as-active',
        why: '未来の timestamp を 0 に丸めて「稼働中」と断言する（動いていないものを動いていると言う）',
        file: 'v0/transcript.mjs',
        from: '        if (delta < 0) {',
        to: '        if (false) {   /* 変異: 未来でも稼働中と言う */',
        gone: 'if (delta < 0) {',
        pattern: '記録の時刻が未来なら',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'lastoutput-cut-by-length',
        why: '切ったかを長さ比較で決める（上限ちょうどのとき告知なしで古い出力が消える）',
        file: 'v0/execsession.mjs',
        from: '        return (cut || text.length > max) ? `…${text.slice(-max)}` : text;',
        to: '        return text.length > max ? `…${text.slice(-max)}` : text;   /* 変異 */',
        gone: 'return (cut || text.length > max)',
        pattern: '上限ちょうどで切ったときも',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'since-negative-from',
        why: '負の通番を 0 に丸めない（1件も捨てていないのに「N 件を省略しました」と告知する）',
        file: 'v0/execsession.mjs',
        from: '        const n = Number.isFinite(from) && from > 0 ? from : 0;',
        to: '        const n = Number.isFinite(from) ? from : 0;   /* 変異 */',
        gone: 'Number.isFinite(from) && from > 0',
        pattern: '負の通番でも',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'input-starting-lies',
        why: '起動途中を「標準入力は既に閉じています」と言う（送り直せば通るのに諦めさせる）',
        file: 'v0/server.mjs',
        from: '                    if (!s.child) {',
        to: '                    if (false) {   /* 変異: 起動途中も「閉じています」と言う */',
        gone: 'if (!s.child) {',
        pattern: '起動途中への入力',
    },
    {
        // ⚠️ MINOR: --port の値の欠落を黙って既定に落とす
        name: 'port-missing-value-default',
        why: '--port の値が無いのを黙って既定にする（打ったつもりのポートで起動しない）',
        file: 'scripts/serveargs.mjs',
        from: "    if (raw === undefined || String(raw).startsWith('-')) return { error: raw ?? '(無し)' };\n    return checkPort(raw, def);",
        to: '    return checkPort(raw, def);   /* 変異: 値が無くても既定に落とす */',
        gone: "return { error: raw ?? '(無し)' };\n    return checkPort(raw, def);",
        pattern: 'portFrom: --port の値が無い',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 MINOR だが実害が大きい: --stop --repo の値の欠落でカレントを殺す
        name: 'stop-repo-missing-value',
        why: '--stop --repo の値が無いのをカレントに落とす（意図と違うデーモンを子ごと taskkill する）',
        file: 'scripts/serveargs.mjs',
        from: '        return { error: raw ?? \'(無し)\' };\n    }\n    return { repo: String(raw) };',
        to: '        return { repo: null };   /* 変異: 値が無ければカレント */\n    }\n    return { repo: String(raw) };',
        gone: 'return { error: raw ?? \'(無し)\' };\n    }\n    return { repo: String(raw) };',
        pattern: 'stopRepoFrom: --repo の値が無ければ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // ⚠️ MINOR: --allow-host の値の欠落で 'undefined' を登録する
        name: 'allow-host-missing-value',
        why: '--allow-host の値が無いと undefined をホストとして登録する（https://undefined/?token= を案内する）',
        file: 'v0/server.mjs',
        from: "            if (h === undefined || String(h).startsWith('-') || !String(h).trim()) {",
        to: '            if (false) {   /* 変異: 値が無くても登録する */',
        gone: "if (h === undefined || String(h).startsWith('-') || !String(h).trim()) {",
        pattern: 'allow-host の値が無ければ起動を止める',
    },
    {
        // 🚨 #74: 解決できないパスをそのまま Run キーに書く（ログオン時だけ壊れる）
        name: 'autostart-repo-unchecked',
        why: 'install が --repo を解決せずに登録する（ログオン時にだけ起動に失敗する = 手元では気付けない）',
        file: 'scripts/autostart.mjs',
        from: '        if (t.code !== 0 || !top) {',
        to: '        if (false) {   /* 変異: 開けなくても登録する */',
        gone: 'if (t.code !== 0 || !top) {',
        pattern: 'autostart install: 開けないパスは登録を拒否する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 #69: 失敗の理由と subtype を捨てる（別の失敗が同じ表示になる）
        name: 'chat-result-reason',
        why: 'result の理由と subtype を落とす（「Credit balance is too low」も error_max_turns も同じ1行になる）',
        file: 'v0/chatfilter.mjs',
        from: '            text: `── ${head}${sub} ──${why}`,',
        to: '            text: `── ${head} ──`,   /* 変異: 理由を捨てる */',
        gone: 'text: `── ${head}${sub} ──${why}`,',
        pattern: 'エラーの理由と subtype を出す',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        // 🚨 #67: 滞留を黙って「送った」と言う
        name: 'input-pending-silent',
        why: '相手が読んでいないのに「送った」と言う（会話が返ってこない理由が画面から分からない）',
        file: 'v0/inputnote.mjs',
        from: '    if (pending > 0) {',
        to: '    if (false) {   /* 変異: 滞留を黙る */',
        gone: 'if (pending > 0) {',
        pattern: '未読が残っていたら',
        testFile: 'v0/inputnote.test.mjs',
    },
    {
        // 🚨 #67: 分からないのに「届いた」と断言する
        name: 'input-unknown-as-delivered',
        why: 'pending が無い応答を「届いた」と断言する（分からないを無いと言う型）',
        file: 'v0/inputnote.mjs',
        from: '    if (!Number.isFinite(pending)) {',
        to: '    if (false) {   /* 変異: 分からないを届いたと言う */',
        gone: 'if (!Number.isFinite(pending)) {',
        pattern: 'pending が無い応答を「届いた」と断言しない',
        testFile: 'v0/inputnote.test.mjs',
    },
    {
        // 🚨 #68: 停止処理中の入力を「送った」と言う
        name: 'input-ignores-kill-requested',
        why: '停止処理中の入力を 200 ok:true で受ける（読まれない1行が「送った」として記録に残る）',
        file: 'v0/server.mjs',
        from: '                    if (s.killRequested) {',
        to: '                    if (false) {   /* 変異: 停止処理中でも受ける */',
        gone: 'if (s.killRequested) {',
        pattern: '停止処理中の入力は 409 で断る',
    },
    {
        // 🚨 #71: 終了済みへの /kill が reap 済みの pid に taskkill を撃つ
        name: 'kill-on-exited-session',
        why: '終了済みセッションにも kill を撃つ（正常終了を「確認できない強制停止」と記録する）',
        file: 'v0/server.mjs',
        from: '                    if (!s.running) {\n                        await auditExec({\n                            event: \'kill-noop\',',
        to: '                    if (false) {\n                        await auditExec({\n                            event: \'kill-noop\',',
        gone: 'if (!s.running) {\n                        await auditExec({\n                            event: \'kill-noop\',',
        pattern: '終了済みへの /kill は撃たず',
    },
    {
        // 🚨 #71: reap 済みの子に signal を送る（pid 再利用で無関係を撃つ）
        name: 'killtree-hits-reaped',
        why: '終了済みの子にも taskkill を撃つ（pid が再利用されていれば無関係のプロセスを殺す）',
        file: 'v0/server.mjs',
        from: '    if (child.exitCode !== null || child.signalCode !== null) {',
        to: '    if (false) {   /* 変異: reap 済みでも撃つ */',
        gone: 'if (child.exitCode !== null || child.signalCode !== null) {',
        pattern: '終了済みへの /kill は撃たず',
        defensive: '/kill 側の門（kill-on-exited-session）が先に効くので、現状この2枚目に到達する経路はスモークからは作れない。sweeper と /kill の両方から呼ばれる関数なので、入口の門が1つ外れたときの2枚目として残す',
    },
    {
        // 🚨 #70: バッチの印を await の前に立てないと、次の tick が二重に殺す
        name: 'sweep-marks-inside-loop',
        why: '二重に殺しに行く守りを2枚とも外す（バッチの印 + tick の再入防止）',
        file: 'v0/server.mjs',
        from: '        for (const { session, reason } of kill) session.killRequested = reason;',
        // 🚨 **守りが2枚あるので1枚だけ外しても差が出ない**（実測で SURVIVED）。
        //    再入防止（sweepBusy）だけで重なりは消えるので、`also` で2枚とも外す。
        //    「検査が弱い」と読み違えて検査を強くしに行かないこと。
        also: [{ from: '        if (sweepBusy) return;', to: '        if (false) return;' }],
        to: '        /* 変異: 印をバッチで立てない */',
        gone: 'for (const { session, reason } of kill) session.killRequested = reason;',
        pattern: 'まとめて上限切れでも kill は1本',
    },
    {
        // 🚨 #72: 終了済みの件数に上限が無いと台帳が伸び続ける
        name: 'retain-no-count-cap',
        why: '終了済みの件数を切らない（監視盤の payload が台帳の本数に比例して伸びる）',
        file: 'v0/execsession.mjs',
        from: '        const cap = this.limits.maxRetained;',
        to: '        const cap = 0;   /* 変異: 件数で切らない */',
        gone: 'const cap = this.limits.maxRetained;',
        pattern: '終了済みの件数が上限を超えたら古いものから捨てる',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        // 🚨 #72: 省略したのに告知しない
        name: 'monitor-omits-silently',
        why: '監視盤の一覧を切ったことを告げない（カードはあるのに一覧に無い状態を無言で作る）',
        file: 'v0/execsession.mjs',
        from: '            omitted: all.length - kept.length,',
        to: '            omitted: 0,   /* 変異: 省略を黙る */',
        gone: 'omitted: all.length - kept.length,',
        pattern: '監視盤に返す件数を切ったら、切った数を返す',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        // 🚨 #66: 記号1つを値として食い、本物の秘密を次の行に残す（告知が嘘になる）
        name: 'mask-punct-eats-value',
        why: '鍵の直後の記号1つを値として食う（「秘密を落としました」と言いながら本物が残る）',
        file: 'v0/transcript.mjs',
        from: 'const SECRET_VALUE_SMART = "(?:" + PUNCT_ONLY + SECRET_WS + "+)?" + SECRET_VALUE;',
        to: 'const SECRET_VALUE_SMART = SECRET_VALUE;   /* 変異: 記号を飛ばさない */',
        gone: 'const SECRET_VALUE_SMART = "(?:" + PUNCT_ONLY',
        pattern: '記号1つを値として食って本物を残さない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 #61: 対象の判定を1本目だけに戻す（複数 repo のデーモンに嘘をつく）
        name: 'stop-first-repo-only',
        why: '--repo の1本目だけで自分のデーモンか判定する（2本目のリポジトリで「動いていません」と断言する）',
        file: 'scripts/serveargs.mjs',
        from: '    const list = reposOf(cmd);',
        to: '    const list = [repoOf(cmd)].filter(Boolean);   /* 変異: 1本目だけ */',
        gone: 'const list = reposOf(cmd);',
        pattern: '1本目以外でも「自分のデーモン」と判定する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 #61: 「読めなかった」を「別のリポジトリ」に潰す（#54 の再発）
        name: 'stop-unknown-as-other',
        why: 'コマンド行を読めなかったデーモンを「別のリポジトリ」と断言する（止め残しに気付けない）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!list || !list.length) return null;',
        to: '    if (!list || !list.length) return false;   /* 変異: 分からないを別物と言う */',
        gone: 'if (!list || !list.length) return null;',
        pattern: '1本目以外でも「自分のデーモン」と判定する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 #65: merge のシーケンサ門（外しても smoke が全部緑だった）
        name: 'merge-sequencer-gate',
        why: 'rebase 停止中でも取り込む（git は exit 0 で通し、--continue が別ブランチに残す）',
        file: 'v0/server.mjs',
        // ⚠️ `if (blockers.length) {` は checkout 側にもあるので**一意にならない**。
        //    後ろの行（merge だけの文言）まで含めて指定する
        from: '            if (blockers.length) {\n                denyJson(res, 409,\n'
            + '                    `${blockers.join(\' / \')} のため取り込みを拒否しました。`',
        to: '            if (false) {   /* 変異: 停止中でも取り込む */\n                denyJson(res, 409,\n'
            + '                    `${blockers.join(\' / \')} のため取り込みを拒否しました。`',
        // ⚠️ `gone` も改行込みで一意にする（checkout 側の同じ文言に当たるため）
        gone: 'if (blockers.length) {\n                denyJson(res, 409,\n'
            + '                    `${blockers.join(\' / \')} のため取り込みを拒否しました。`',
        pattern: 'merge: シーケンサ停止中は拒否する',
    },
    {
        // 🚨 #60: ラベル（表示名）を ref として送る = 別のブランチが取り込まれる
        name: 'merge-label-as-ref',
        why: '提案のラベルをそのまま branch として送る（無関係なブランチが取り込まれ、門も別ペアを見る）',
        file: 'v0/mergeplan.mjs',
        from: '        entries.push({ label, branch: w.branch });',
        to: '        entries.push({ label, branch: label });   /* 変異: ラベルを ref にする */',
        gone: 'entries.push({ label, branch: w.branch });',
        pattern: 'ラベルではなくブランチを返す',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        // 🚨 #60: 解決できないものを黙って落とす（省略の告知が消える）
        name: 'merge-skips-silently',
        why: '解決できない候補を理由なしで落とす（ボタンが黙って減る）',
        file: 'v0/mergeplan.mjs',
        from: "        if (!w) { skipped.push({ label, why: 'この worktree が一覧にありません' }); continue; }",
        to: "        if (!w) { continue; }   /* 変異: 黙って落とす */",
        gone: "skipped.push({ label, why: 'この worktree が一覧にありません' })",
        pattern: '解決できないものは黙って落とさず理由を返す',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        // 🚨 #60: payload に無いフィールド（shortBranch）で取り込み先を選ぶ
        name: 'merge-target-wrong-field',
        why: 'payload に存在しない shortBranch で取り込み先を探す（常に一覧の先頭になる）',
        file: 'v0/mergeplan.mjs',
        from: '    const target = list.find(w => w.branch && w.branch === base) ?? list[0] ?? null;',
        to: '    const target = list.find(w => w.shortBranch === base) ?? list[0] ?? null;   /* 変異 */',
        gone: 'w.branch && w.branch === base',
        pattern: '取り込み先は先頭ではなく base の worktree',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        // 🚨 #62: precheck の同時実行を縛らない（1要求で worktree 本数分の git）
        name: 'precheck-no-inflight-gate',
        why: 'precheck の同時実行を縛らない（読み取り鍵だけで worktree 本数×並列の git を起動できる）',
        file: 'v0/server.mjs',
        from: '            if (!precheckGate.acquire(peerKey(req))) {',
        to: '            if (false) {   /* 変異: 並列を縛らない */',
        gone: 'if (!precheckGate.acquire(peerKey(req))) {',
        pattern: '連投は畳まれ、同時実行に上限がある',
    },
    {
        // 🚨 #62: 連投を畳まない（TTL キャッシュ・重複排除を外す）
        name: 'precheck-no-cache',
        why: 'precheck の連投を畳まない（同じ問い合わせのたびに worktree 本数分の git を起動する）',
        file: 'v0/server.mjs',
        from: '    if (hit) return hit.p;',
        to: '    if (false) return hit.p;   /* 変異: 毎回計算する */',
        gone: 'if (hit) return hit.p;',
        pattern: '連投は畳まれ、同時実行に上限がある',
    },
    {
        // 🔒 #62: 別オリジン起点（他ポート / 同一 tailnet の別ノード）から撃てる
        name: 'precheck-any-origin',
        why: 'precheck を別オリジンのページから撃てるようにする（blind でコストだけ掛けられる）',
        file: 'v0/server.mjs',
        from: '                if (site && site !== \'same-origin\') {\n                    denyJson(res, 403,\n                        `別オリジン起点の問い合わせは拒否します (Sec-Fetch-Site: ${site})`);',
        to: '                if (false) {\n                    denyJson(res, 403,\n                        `別オリジン起点の問い合わせは拒否します (Sec-Fetch-Site: ${site})`);',
        gone: 'if (site && site !== \'same-origin\') {\n                    denyJson(res, 403,',
        pattern: '連投は畳まれ、同時実行に上限がある',
    },
    {
        // 🔒 #64: 検査専用の経路を門の手前に戻す（無認証でデーモンを落とせる）
        name: 'probe-shutdown-before-gate',
        why: '検査専用の /__shutdown を Host 検証・認証より前に置く（無認証で落とせる）',
        file: 'v0/server.mjs',
        from: "    if (opts.layoutProbe && url.pathname === '/__shutdown') {",
        to: '    if (false) {   /* 変異: 門の後ろでは受けない */',
        also: [{ from: 'async function handleRequest(req, res) {', to: "async function handleRequest(req, res) {\\n    if (opts.layoutProbe && req.url === '/__shutdown') {   /* 変異: 門の手前 */\\n        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });\\n        res.end('shutting down');\\n        shutdown('probe').catch(() => {});\\n        return;\\n    }" }],
        gone: "if (opts.layoutProbe && url.pathname === '/__shutdown') {",
        pattern: '検査専用の /__shutdown は認証を通らないと落とせない',
    },
    {
        // 🔒 #64: トンネルに検査経路を出せてしまう構成を作らせない門
        name: 'probe-with-allow-host',
        why: '--layout-probe と --allow-host の併用を許す（検査経路をトンネルに出す）',
        file: 'v0/server.mjs',
        from: 'if (opts.layoutProbe && opts.allowHosts.size > 0) {',
        to: 'if (false) {   /* 変異: 併用を許す */',
        gone: 'if (opts.layoutProbe && opts.allowHosts.size > 0) {',
        pattern: '--layout-probe と --allow-host は併用できない',
    },
    {
        // 🔒 #63: `/state` の execSessions 可視判定を壁の外に戻す
        //    （読み取り鍵だけの相手が実行トークンを1要求1bitで総当たりできる）
        name: 'state-token-oracle-unwalled',
        why: '実行トークンの当たり判定を門・記録・遅延の外に出す（read から exec への昇格）',
        file: 'v0/server.mjs',
        from: '            const shown = await presentedTokenAudited(req, res, url);\n            if (shown.handled) return;\n            const body = JSON.stringify(',
        to: '            const shown = { ok: presentedToken(req, url), handled: false };   /* 変異 */\n            const body = JSON.stringify(',
        gone: 'const shown = await presentedTokenAudited(req, res, url);\n            if (shown.handled) return;\n            const body',
        pattern: 'state/session の実行トークン当て判定',
    },
    {
        name: 'read-secret-rotates-on-restart',
        why: '読み取り専用でも token-read に書き戻す（起動のたびに鍵が回り、ブックマークが 401 になる）',
        file: 'scripts/serveargs.mjs',
        from: '    return norm(tokenFile) !== norm(readFile);',
        to: '    return true;   /* 変異: 同じファイルでも書き戻す */',
        gone: 'return norm(tokenFile) !== norm(readFile);',
        pattern: 'token-file が token-read 自身なら書かない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    // -----------------------------------------------------------------
    // 🚨 #58: 入力層の検査（CDP）。**この検査を動かす変異が1件も無かった**
    //    （しかも検査は末尾の process.exit(0) で構造的に落ちられなかった）。
    // -----------------------------------------------------------------
    {
        name: 'grid-drag-does-not-move',
        why: 'グリッドで掴んでもセルを動かさない（直近3回連続で壊れた場所）',
        file: 'v0/app.html',
        from: '        const r = moveCell(paneGrid, p.dataset.paneId, c);',
        to: '        const r = { ok: false };   /* 変異: 掴んでも動かさない */',
        gone: 'const r = moveCell(paneGrid, p.dataset.paneId, c);',
        script: 'v0/input-check.mjs',
    },
    {
        // 🚨 **守りが2枚あるので、1枚だけ外しても差が出ない**（実測: 片方ずつ外した
        //    `header-drag-selects-text` / `header-user-select-none` は**どちらも SURVIVED**）。
        //    「片方が残っているから落ちない」のを「検査が弱い」と読み違えると、
        //    検査を無駄に強くする方に行く。**測りたいのは利用者に見えた壊れ方**
        //    （ヘッダを掴んだら文字選択になって動かせない）なので、`also` で2枚とも外す。
        name: 'header-drag-selects-text',
        why: 'ヘッダの掴みで文字選択を止めない2枚（preventDefault と user-select）を両方外す',
        file: 'v0/app.html',
        also: [{
            // ⚠️ 先頭の改行 + 4 空白まで含めて一意にする（もう1箇所の user-select は
            //    `color: var(--dim);` と同じ行にあるので、これで衝突しない）
            from: '\n    user-select: none; -webkit-user-select: none; }',
            to: '\n    }   /* 変異: 選択を許す */',
        }],
        from: '    e.preventDefault();\n    const x0 = e.clientX, y0 = e.clientY;',
        to: '    /* 変異: 既定動作を止めない */\n    const x0 = e.clientX, y0 = e.clientY;',
        gone: 'e.preventDefault();\n    const x0 = e.clientX',
        script: 'v0/input-check.mjs',
    },
    {
        name: 'read-secret-not-derived',
        why: '案内 URL とフックに配る鍵を派生させない（read が RCE に昇格する）',
        file: 'v0/readsecret.mjs',
        from: '    return derive(token);',
        to: '    return token;   /* 変異: 生トークンをそのまま配る */',
        gone: '    return derive(token);',
        pattern: '案内の URL の鍵では実行できない',
    },
    // -----------------------------------------------------------------
    // 🚨 #59: 編集前の衝突ガード。守りは「調べられなかったを衝突なしと言わない」。
    // -----------------------------------------------------------------
    {
        name: 'precheck-daemon-down-allows',
        why: 'デーモンに繋がらないとき黙って通す（見ていないのに「見た」と言う）',
        file: 'v0/precheck.mjs',
        from: 'const UNREACHABLE = ASK;',
        to: 'const UNREACHABLE = ALLOW;   /* 変異: 繋がらなくても通す */',
        gone: 'const UNREACHABLE = ASK;',
        pattern: 'デーモンに繋がらないとき allow にしない',
        testFile: 'v0/precheck.test.mjs',
    },
    {
        name: 'precheck-undecided-allows',
        why: '一部を判定できなくても通す（unknown を無視する）',
        file: 'v0/precheck.mjs',
        from: 'const UNDECIDED = ASK;',
        to: 'const UNDECIDED = ALLOW;   /* 変異: 判定できなくても通す */',
        gone: 'const UNDECIDED = ASK;',
        pattern: '一部でも判定できなければ allow にしない',
        testFile: 'v0/precheck.test.mjs',
    },
    {
        name: 'precheck-ignores-stopped-sequencer',
        why: 'rebase 停止中の worktree での編集を通す（シーケンサ乗っ取りの本体）',
        file: 'v0/precheck.mjs',
        from: '    if (stopped) {',
        to: '    if (false && stopped) {   /* 変異: 停止中でも通す */',
        gone: '    if (stopped) {',
        pattern: '自分がシーケンサ停止中なら拒否する',
        testFile: 'v0/precheck.test.mjs',
    },
    {
        name: 'precheck-ignores-conflicts',
        why: '衝突が見つかっても通す（問い合わせの意味が消える）',
        file: 'v0/precheck.mjs',
        from: '    if (hits.length) {',
        to: '    if (false && hits.length) {   /* 変異: 衝突しても通す */',
        gone: '    if (hits.length) {',
        pattern: '触るパスが衝突していれば拒否',
        testFile: 'v0/precheck.test.mjs',
    },
    {
        name: 'precheck-hides-self-sequencer',
        why: '自分の worktree のシーケンサ状態を返さない（フックが乗っ取りを見落とす）',
        file: 'v0/server.mjs',
        from: '                self, conflicts, busy, unknown,',
        to: '                conflicts, busy, unknown,   /* 変異: self を返さない */',
        gone: '                self, conflicts, busy, unknown,',
        pattern: '自分がシーケンサ停止中なら self に出す',
    },
    {
        name: 'precheck-unknown-worktree-falls-back',
        why: '知らない worktree を1本目にすり替える（別の worktree の判定を返す）',
        file: 'v0/server.mjs',
        from: '    const me = worktrees.find(w => samePath(w.path, wantPath));',
        to: '    const me = worktrees.find(w => samePath(w.path, wantPath)) ?? worktrees[0];   /* 変異 */',
        gone: '    const me = worktrees.find(w => samePath(w.path, wantPath));',
        pattern: '知らない worktree に「衝突なし」と答えない',
    },
    // -----------------------------------------------------------------
    // 🚨 #57: 閉じる／開く。守りは「覚える」「一覧に出す」「作り直さない」。
    // -----------------------------------------------------------------
    // 🚨 #57: パターン（1枚 / 1行2列 / 1行3列 / 2×2 … 4×4）と結合。
    {
        name: 'preset-keeps-order',
        why: 'パターンを当てるときに読み順を捨てる（形を変えるとペインが総入れ替えになる）',
        file: 'v0/panegrid.mjs',
        from: "    const placed = [...(grid?.cells ?? [])]\n        .sort((a, b) => (a.row - b.row) || (a.col - b.col))\n        .map(c => c.id);",
        to: "    const placed = [];   /* 変異: 今の並びを捨てる */",
        gone: "const placed = [...(grid?.cells ?? [])]",
        pattern: 'パターンを当てても読み順',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'preset-unmerge-announced',
        why: '結合を解いたことを告げない（広げたはずのペインが黙って1セルに戻る）',
        file: 'v0/panegrid.mjs',
        from: "    const unmerged = (grid?.cells ?? []).filter(c => c.cw > 1 || c.ch > 1).length;",
        to: "    const unmerged = 0;   /* 変異: 解いたことを言わない */",
        gone: "const unmerged = (grid?.cells ?? []).filter(c => c.cw > 1 || c.ch > 1).length;",
        pattern: '結合は解け、解いた件数を返す',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'preset-unknown-name',
        why: '知らないパターン名で既定の形に変えてしまう（打ち間違いで配置が壊れる）',
        file: 'v0/panegrid.mjs',
        from: "    if (!p) return { grid, overflow: [], unmerged: 0 };",
        to: "    /* 変異: 知らない名前でも進む */",
        gone: "if (!p) return { grid, overflow: [], unmerged: 0 };",
        pattern: '知らないパターン名は何も変えない',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'preset-keeps-closed',
        why: 'パターンを当てると閉じた記憶が消える（形を変えたら閉じたものが戻ってくる）',
        file: 'v0/panegrid.mjs',
        from: "        closed: [...(grid?.closed ?? [])],\n    };\n    const out = autoPlace(fresh, order);",
        to: "        closed: [],   /* 変異: 閉じた記憶を捨てる */\n    };\n    const out = autoPlace(fresh, order);",
        gone: "closed: [...(grid?.closed ?? [])],\n    };\n    const out = autoPlace(fresh, order);",
        pattern: '結合は解け、解いた件数を返す',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'merge-direction',
        why: '知らない方向でも広げる（押した向きと違う方向に広がる）',
        file: 'v0/panegrid.mjs',
        from: "    else return { grid, ok: false, why: `知らない方向です: ${dir}`, displaced: [] };",
        to: "    return resizeCell(grid, id, me.cw + 1, me.ch);   /* 変異: 右に広げる */",
        gone: "知らない方向です",
        pattern: '結合は隣を占め',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'close-is-remembered',
        why: '閉じたことを覚えない（15秒ごとの更新で戻ってきて閉じられない）',
        file: 'v0/panelayout.mjs',
        from: '    return { ...layout, closed: [...(layout.closed ?? []), paneId] };',
        to: '    return layout;   /* 変異: 閉じたことを覚えない */',
        gone: 'closed: [...(layout.closed ?? []), paneId]',
        pattern: '閉じたことを覚え、開けば戻る',
        testFile: 'v0/panelayout.test.mjs',
    },
    {
        // ⚠️ 並べ替えで閉じた記憶が落ちると、ドラッグしただけで閉じたものが戻る
        name: 'close-survives-reorder',
        why: '並べ替えのときに閉じた記憶を落とす（ドラッグで閉じたものが戻ってくる）',
        file: 'v0/panelayout.mjs',
        from: '    out.closed = [...(layout.closed ?? [])];\n    return out;\n}',
        to: '    return out;\n}',
        gone: '    out.closed = [...(layout.closed ?? [])];\n    return out;',
        pattern: '閉じた記憶が保存と読み込みで往復する',
        testFile: 'v0/panelayout.test.mjs',
    },
    {
        // 🚨 前方互換: closed が無い古い保存値で並びが消えてはいけない
        name: 'close-parse-tolerant',
        why: '古い保存値（closed 無し）を読めなくする（利用者の並びが1回消える）',
        file: 'v0/panelayout.mjs',
        from: '    for (const id of Array.isArray(raw.closed) ? raw.closed : []) {',
        to: '    for (const id of raw.closed) {   /* 変異: closed を必須にする */',
        gone: 'Array.isArray(raw.closed) ? raw.closed : []',
        pattern: '古い値も読める',
        testFile: 'v0/panelayout.test.mjs',
    },
    {
        // 🚨 描画が閉じたペインを作り直すと、記憶があっても戻ってくる（配線）
        name: 'close-not-recreated',
        why: '閉じているペインを描画が作り直す（更新で戻ってきて閉じられない）',
        file: 'v0/app.html',
        from: '  if (isHidden(paneLayout, id)) return null;',
        to: '  /* 変異: 閉じていても作る */',
        gone: 'if (isHidden(paneLayout, id)) return null;',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 実機で × と結合ボタンが**無反応**だった原因。ヘッダの pointerdown が
        //    ポインタを掴むと、以降の事象がヘッダに再ターゲットされて click が飛ばない。
        //    検査が `.click()` を直接呼んでいたのでこの壊れ方が見えなかった。
        name: 'pane-drag-skips-buttons',
        why: 'ヘッダのボタンでもドラッグを始める（掴むので click が飛ばず、'
            + '閉じる・結合・最小化が実際の指では無反応になる）',
        file: 'v0/app.html',
        from: "    if (e.target?.closest?.('button')) return;",
        to: '    /* 変異: ボタンでも掴む */',
        gone: "if (e.target?.closest?.('button')) return;",
        script: 'v0/render-check.mjs',
        // ⚠️ **この守りは検査環境では測れない（実測して確認した）。**
        //    ブラウザは**合成の pointer 事象から click を生成しない**ので、
        //    「掴んで click が飲まれる」形が再現できない（検査は click() を
        //    直接呼ぶしかなく、直接呼べば capture に関係なく発火する）。
        //    実機（Android / Chrome）でだけ起きる壊れ方で、そこで見つかった。
        defensive: 'ブラウザは合成 pointer 事象から click を生成しないので、'
            + 'capture が click を飲む形を検査環境で再現できない。'
            + '実機で見つけた壊れ方なので、守りは残して理由を書く',
    },
    {
        // 🚨 一覧が無いと「閉じたら二度と開けない」= 閉じるのが危険な操作になる
        name: 'closed-list-shown',
        why: '閉じたペインの一覧を出さない（開き直す手段が無くなる）',
        file: 'v0/app.html',
        // ⚠️ `box.hidden = false;` はグリッドの帯にも出てきたので、
        //    **閉じた一覧のものだけ**を指す形にする（3箇所に一致して STALE になった）
        from: '  if (!ids.length) { box.hidden = true; return; }',
        to: '  if (true) { box.hidden = true; return; }   /* 変異: 一覧を出さない */',
        gone: '  if (!ids.length) { box.hidden = true; return; }',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'url-crash',
        why: '不正な request-target で認証前にプロセスが落ちる',
        file: 'v0/server.mjs',
        from: `    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request target\\n');
        return;
    }
`,
        to: "    const url = new URL(req.url, 'http://localhost');\n",
        gone: 'bad request target',
        pattern: 'request-target',
    },
    {
        name: 'host-check',
        why: 'DNS rebinding（Host 検証を外す）',
        file: 'v0/server.mjs',
        from: '    if (!hostAllowed(req) || !siteAllowed(req)) {',
        to: '    if (false) {',
        gone: '!hostAllowed(req)',
        pattern: 'DNS rebinding',
    },
    {
        // 🚨 8回目のレビュー: fsmonitor と**同じクラス**の穴が filter 側に残っていた。
        //    フラグ1つも付けない読み取り専用デーモンが status を1回叩くだけで実行する。
        name: 'filter-neutralize',
        why: '.gitattributes の filter を潰さない'
            + '（capability ゼロの読み取り経路から任意コマンドが走る）',
        file: 'v0/git.mjs',
        from: "        args.push('-c', `filter.${name}.clean=cat`);",
        to: '        /* 変異: clean を潰さない */',
        gone: 'filter.${name}.clean=cat',
        pattern: 'リポジトリ設定の filter を実行しない',
    },
    {
        name: 'filter-status-passes-names',
        why: 'status に filter の名前を渡さない（潰す仕組みがあっても効かない）',
        file: 'v0/server.mjs',
        from: '            worktreeStatus(wt.path, filters).catch(e => {',
        to: '            worktreeStatus(wt.path).catch(e => {',
        gone: 'worktreeStatus(wt.path, filters)',
        pattern: 'リポジトリ設定の filter を実行しない',
    },
    {
        name: 'filter-announced',
        why: '潰したことを告知しない（変更ありの判定が実際と違うのに黙る）',
        file: 'v0/server.mjs',
        from: "            message: `リポジトリ設定の filter（${filters.map(f => f.name).join(', ')}）を無効化して読みました`",
        to: '            message: `（告知を落とす変異）`',
        gone: 'を無効化して読みました',
        pattern: 'リポジトリ設定の filter を実行しない',
    },
    {
        // 🚨 9回目のレビュー: include.path で .git の外に置くと判定が外れ、
        //    capability ゼロの RCE が復活していた（8回目の対策の回避）
        name: 'filter-scope-allowlist',
        why: 'filter の帰属を許可リスト（system/global 以外はリポジトリ側）で判定しない'
            + '（include.path で .git の外に置くだけで capability ゼロの任意コード実行）',
        file: 'v0/git.mjs',
        from: "            if (scope === 'system' || scope === 'global') continue;",
        // ⚠️ `scope !== 'local'` では**元のバグを再現しない**（include も local と
        //    報告されるので通ってしまい SURVIVED になった）。local を落として測る
        to: "            if (scope !== 'worktree') continue;   /* 変異: local を捨てる */",
        gone: "scope === 'system' || scope === 'global'",
        pattern: 'include.path で外に置いた filter',
    },
    {
        name: 'merge-filter-gate-order',
        why: 'filter の門を無効化し、dirty の判定に filter を渡さない'
            + '（「filter は任意コマンドを起動するので断る」と言う前に1回実行する形に戻す）',
        file: 'v0/server.mjs',
        // ⚠️ **`worktreeStatus` の引数だけを外しても SURVIVED する**（門が先に 409 を返すので
        //    その status に到達しない。実測）。門の無効化と**対にして**測る。
        //    `also` は「同じ守りが二重で、片方ずつでは測れない」ときの仕組み。
        from: '            const coFilters = await repoFilterNames(wt.path);',
        to: '            const coFilters = [];   /* 変異(1/2): checkout の門も外す */',
        gone: 'const coFilters = await repoFilterNames(wt.path);',
        also: [
            {
                from: '            if (filterNames.length) {\n                denyJson(res, 409,',
                to: '            if (false) {\n                denyJson(res, 409,',
            },
            {
                from: '            const st = await worktreeStatus(wt.path, filterNames).catch(() => null);',
                to: '            const st = await worktreeStatus(wt.path).catch(() => null);',
            },
        ],
        pattern: 'その前に filter を実行していない',
    },
    {
        name: 'checkout-refuses-filter',
        why: 'filter があるリポジトリでも checkout する'
            + '（作業ツリーを書き換えるので smudge = 任意コマンドが --allow-write だけで走る）',
        file: 'v0/server.mjs',
        from: '            const coFilters = await repoFilterNames(wt.path);',
        to: '            const coFilters = [];   /* 変異: filter を見ない */',
        gone: 'const coFilters = await repoFilterNames(wt.path);',
        pattern: 'checkout: リポジトリ設定の filter',
    },
    {
        name: 'merge-refuses-filter',
        why: 'filter があるリポジトリでも取り込む'
            + '（任意コマンドが走る。潰すと作業ツリーの中身が変わるので断るしかない）',
        file: 'v0/server.mjs',
        from: '            const filterNames = await repoFilterNames(wt.path);',
        to: '            const filterNames = [];   /* 変異: filter を見ない */',
        gone: 'const filterNames = await repoFilterNames(wt.path',
        pattern: 'merge: リポジトリ設定の filter があるときは実行しない',
    },
    {
        name: 'merge-no-gpgsign',
        why: 'merge が commit.gpgsign / gpg.program を無効化しない'
            + '（書き込みの capability で任意プログラム実行）',
        file: 'v0/server.mjs',
        from: "                    '-c', 'commit.gpgsign=false',",
        to: '                    /* 変異: 署名を潰さない */',
        gone: "'commit.gpgsign=false'",
        pattern: 'merge が commit.gpgsign',
    },
    {
        name: 'fsmonitor',
        why: '読み取り経路がリポジトリ設定のコマンドを実行する',
        file: 'v0/git.mjs',
        from: "    '-c', 'core.fsmonitor=false',\n",
        to: '',
        gone: "'core.fsmonitor=false'",
        pattern: 'core.fsmonitor',
    },
    {
        // 🚨 8回目のレビュー: --token-file には門があったのに --audit-log は素通り
        //    （監査ログは argv を**マスクせずに**保存するので、コミットされると外に出る）
        name: 'audit-log-inside-worktree',
        why: '監査ログを worktree の中に置かせる'
            + '（マスクしていない argv が git add -A でコミットされ、push で外に出る）',
        file: 'v0/server.mjs',
        from: '    if (inWorktree) {',
        to: '    if (false) {   /* 変異: 門を外す */',
        gone: 'if (inWorktree) {',
        pattern: 'worktree の中に置くと起動を拒否する',
    },
    {
        name: 'audit-log-allows-git-dir',
        why: '.git の中の監査ログも拒否する（既定の置き場所を自分で否定して起動できなくなる）',
        file: 'v0/server.mjs',
        // ⚠️ `.git` の判定は `insideRepoGate()` が返す `inGitDir` に移した
        //    （複数リポジトリでは呼び出し側で commonDir を叩き直すと1本目だけを
        //     見ることになるため）。字面が変わったので追随（--dry で検出）。
        from: '    const inWorktree = gate.inside === true && gate.inGitDir !== true;',
        to: '    const inWorktree = gate.inside === true;   /* 変異: .git の中も拒否する */',
        gone: 'gate.inGitDir !== true',
        pattern: '.git の中なら通す',
    },
    {
        name: 'token-file-inside-repo',
        why: '表記の違い（8.3 短縮名 / symlink / /private/var）でリポジトリ内判定が外れ、'
            + '実行トークンがコミットされる',
        file: 'v0/git.mjs',
        // 祖先を realpath して継ぎ足す部分を消す = 素の文字列比較に戻す
        from: '        if (resolveAncestor) {\n',
        to: '        if (false) {\n',
        gone: 'if (resolveAncestor) {',
        pattern: 'まだ無いファイルでも別表記',
        testFile: 'v0/paths.test.mjs',
    },
    // #17: 「切断で殺す」をやめた代わりの制約。**外すと取り残しが戻る。**
    {
        name: 'exec-detached-grace',
        why: '切断後の猶予を無くす（購読者がいなくても永久に走り続け、取り残しが溜まる）',
        file: 'v0/execsession.mjs',
        from: `                if (!s.keepAlive && s.lastDetachedAt !== null
                    && now - s.lastDetachedAt >= this.limits.detachedGraceMs) {
                    kill.push({ session: s, reason: 'detached' });
                }`,
        to: '                /* 変異: 切断後の猶予をやめる */',
        gone: "reason: 'detached'",
        pattern: '切断後は猶予が過ぎたら殺す',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-absolute-timeout',
        why: '絶対上限を外す（keepAlive のセッションが無限に走る）',
        file: 'v0/execsession.mjs',
        from: `                if (now - s.createdAt >= this.execTimeoutMs) {
                    kill.push({ session: s, reason: 'timeout' });
                    continue;
                }`,
        to: '                /* 変異: 絶対上限をやめる */',
        gone: "reason: 'timeout'",
        pattern: '絶対上限（--exec-timeout）は keepAlive でも効く',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-retain-evict',
        why: '終了したセッションを台帳から消さない（メモリに溜まり続ける）',
        file: 'v0/execsession.mjs',
        // ⚠️ #24 の修正で条件から `&& !s.subscribers.size` を外したので追随させた。
        //    「消すかどうか」を測るのがこちら、「購読者がいても消すか」は
        //    `exec-evict-with-subscribers` が測る（別の守り）
        from: '            if (now - doneAt >= this.limits.retainMs) evict.push(s);',
        to: '            /* 変異: 終了後の掃除をやめる */',
        gone: 'evict.push(s)',
        pattern: '保持期間のあいだ残り、過ぎたら台帳から消える',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-slot-reserve-sync',
        why: '同時セッションの上限が効かない（8に対して24本走った実測がある）',
        file: 'v0/execsession.mjs',
        from: '        if (this.reserved >= this.limits.maxConcurrent) return null;',
        to: '        /* 変異: 上限の検査をやめる */',
        gone: 'this.reserved >= this.limits.maxConcurrent',
        pattern: '同時セッションの上限が効き',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-ring-missing',
        why: 'リングバッファで捨てた件数を告知しない（出力が完全だと誤解される）',
        file: 'v0/execsession.mjs',
        from: '        const missing = Math.max(0, firstKept - 1 - n);',
        to: '        const missing = 0;',
        gone: 'firstKept - 1 - n',
        pattern: '上限で捨てたら missing で告知できる',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-session-id-validation',
        why: 'セッション id の形を検証しない（HTTP から来た値をそのまま台帳に引く）',
        file: 'v0/execsession.mjs',
        from: '    return typeof v === \'string\' && ID_RE.test(v);',
        to: '    return typeof v === \'string\';',
        gone: 'ID_RE.test(v)',
        pattern: '形の違うものを弾く',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-kill-on-shutdown',
        why: 'サーバ終了時に子プロセスを置き去りにする'
            + '（Windows では libuv が SILENT_BREAKAWAY_OK を立てるので孫が回収されない）',
        file: 'v0/server.mjs',
        from: '        jobs.push(killTree(s.child).then(r => ({ s, r }), () => ({ s, r: null })));',
        to: '        /* 変異: 終了時の後始末をやめる */',
        gone: 'jobs.push(killTree(s.child)',
        // ⚠️ 以前は `platforms: ['linux','darwin']` だった（signal でしか終了処理を
        //    起こせなかったため）。`--layout-probe` の `/__shutdown` を足したので
        //    **Windows でも測れる**ようになった（シグナルへの登録だけが POSIX 限定）。
        pattern: '子を回収し、終了処理中の実行を断り',
    },
    {
        // 🚨 数え直しの入口。0 や負値を `process.kill` に渡すと意味が変わる
        //    （0 = 自分のプロセスグループ、負値 = グループ）。落とさないと
        //    **自分自身を「まだ生きている子」と数えて永久に killed:false** になる。
        // ⚠️ `descendantsOf` の循環対策（`seen`）には変異を置いていない。
        //    外すと**落ちるのではなく停止しなくなる**（無限ループ → 300 秒で打ち切り）。
        //    打ち切りを結果として読む形は作らない、という規則に従って置かない。
        //    検査は `v0/proctree.test.mjs`（循環する表を渡して止まることを見る）。
        name: 'proctree-invalid-pid',
        why: '0 / 負値 / 整数でない pid を数え直しに渡す'
            + '（0 は自分のプロセスグループなので、自分を「生きている子」と数える）',
        file: 'v0/proctree.mjs',
        from: '        if (!Number.isInteger(pid) || pid <= 0) continue;',
        to: '        /* 変異: 入口の検証を外す */',
        gone: 'if (!Number.isInteger(pid) || pid <= 0) continue;',
        pattern: '0 / 負値 / 整数でない値は数えない',
        testFile: 'v0/proctree.test.mjs',
    },
    {
        // 🚨 9回目のレビュー: ハンドラは SIGINT / SIGTERM にしか付いていなかった。
        //    端末を閉じる（SIGHUP）= 常用の終わり方で、子は別プロセスグループなので
        //    HUP が届かず**確実に生き残る**。
        name: 'shutdown-no-sighup',
        why: 'SIGHUP（端末を閉じる）を登録しない。端末を閉じると子が置き去りになる',
        file: 'v0/server.mjs',
        from: "for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {",
        to: "for (const sig of ['SIGINT', 'SIGTERM']) {   /* 変異: SIGHUP を落とす */",
        gone: "'SIGHUP', 'SIGBREAK'",
        // ⚠️ Windows では process.kill がハンドラを走らせない（TerminateProcess 相当）
        platforms: ['linux', 'darwin'],
        pattern: 'SIGHUP（端末を閉じる）でも子を置き去りにしない',
    },
    {
        // 🚨 9回目のレビュー: 終了処理と POST /api/v0/exec が競争していた
        //    （create → spawn は実測 36〜43ms）。掃いた後に spawn された子は
        //    寿命管理の外に落ちる。
        name: 'shutdown-exec-gate',
        why: '終了処理中でも新しい実行を受け付ける（掃き取りの後に spawn された子が残る）',
        file: 'v0/server.mjs',
        from: `            if (shuttingDown) {
                denyJson(res, 503, '終了処理中です（新しい実行は受け付けません）');
                return;
            }`,
        to: '            /* 変異: 終了処理中でも受け付ける */',
        gone: "denyJson(res, 503, '終了処理中です",
        pattern: '子を回収し、終了処理中の実行を断り',
    },
    {
        // 🚨 9回目のレビュー: `if (s.child)` で起動途中を黙って飛ばしていた
        name: 'shutdown-skips-starting',
        why: '起動途中（child が無い）のセッションに印を付けない'
            + '（終了処理の後に spawn され、寿命管理の外で走り続ける）',
        file: 'v0/server.mjs',
        from: "        s.killRequested = s.killRequested ?? 'shutdown';",
        to: '        /* 変異: 起動途中に印を付けない */',
        gone: "s.killRequested = s.killRequested ?? 'shutdown'",
        pattern: '子を回収し、終了処理中の実行を断り',
    },
    {
        // 🚨 **自分の修正の穴。** 印を付けるだけでは足りず、印を見て殺すのは
        //    spawn 側なので、待たずに process.exit(0) すると殺している途中で
        //    デーモンが消えて子が生き残る（検査が実測で捕まえた）。
        name: 'shutdown-no-wait-for-starting',
        why: '起動途中のセッションが片付くのを待たずに終わる'
            + '（撃つ前の木の列挙に約1秒かかるので、800ms の強制終了と必ず競争する）',
        file: 'v0/server.mjs',
        from: '    for (let i = 0; i < 60 && execRegistry.running.length; i++) {\n'
            + '        await new Promise(r => setTimeout(r, 100));\n    }',
        to: '    /* 変異: 起動途中を待たない */',
        gone: '60 && execRegistry.running.length',
        // ⚠️ **POSIX では観測可能な差が出ない（CI の ubuntu で SURVIVED）。**
        //    待ちが要るのは「印を見て殺す側」が終わる前にプロセスが消えるときで、
        //    その窓の幅は**撃つ前の木の列挙にかかる時間**で決まる:
        //      Windows: PowerShell の CIM で実測 390〜414ms → 800ms の強制終了と競争する
        //      POSIX:   `ps -eo pid=,ppid=` で 10〜20ms → 競争にならない
        //    つまり Windows でだけ効く守り。手元（Windows）で KILLED を確認済み。
        //    🚨 CI の変異は ubuntu で走るので、**ここは CI では測られない**。
        platforms: ['win32'],
        pattern: '子を回収し、終了処理中の実行を断り',
    },
    {
        // 🚨 9回目のレビュー: 数え直しが**直接の子**だけだった。木から外れた孫は
        //    数え直しに掛からないので `{ok:true}` / 「⚠ 停止しました」を返していた。
        name: 'exec-kill-tree-recount',
        why: '数え直しを直接の子だけに戻す'
            + '（木から逃げた孫が生きているのに「停止しました」と言い切る）',
        file: 'v0/server.mjs',
        from: `        const selfDead = child.exitCode !== null || child.signalCode !== null
            || stillAlive([pid]).length === 0;
        const left = stillAlive(tree.pids);
        if (selfDead && left.length === 0) {`,
        to: `        const selfDead = child.exitCode !== null || child.signalCode !== null
            || stillAlive([pid]).length === 0;
        const left = [];   /* 変異: 木を数え直さない */
        if (selfDead && left.length === 0) {`,
        gone: 'const left = stillAlive(tree.pids);',
        // ⚠️ Windows では `taskkill /T` が ppid を辿って孫まで落とすので、
        //    「逃げた孫」を作っても実際に死ぬ = 主張と実態が一致してしまう。
        //    POSIX は kill(-pgid) が別グループに届かないので生き残る。
        platforms: ['linux', 'darwin'],
        pattern: '「停止しました」が実態と一致する',
    },
    {
        name: 'read-auth-gate',
        why: '読み取り経路の認証を外す（トンネルに届く相手が誰でも差分を読める）',
        file: 'v0/server.mjs',
        from: '            pass = authed(req, url);',
        to: '            pass = true;   /* 変異: 認証しない */',
        gone: 'pass = authed(req, url)',
        pattern: 'トークンが無い / 違うと 401',
    },
    {
        name: 'read-auth-default-on-tunnel',
        why: '--allow-host を付けても認証が既定オンにならない'
            + '（無認証のままトンネルに出る）',
        file: 'v0/server.mjs',
        from: 'if (opts.requireAuth === null) opts.requireAuth = opts.allowHosts.size > 0;',
        to: 'if (opts.requireAuth === null) opts.requireAuth = false;',
        gone: 'opts.requireAuth = opts.allowHosts.size > 0',
        pattern: '--allow-host を付けると認証が既定で必須になる',
    },
    {
        name: 'no-auth-with-tunnel-refused',
        why: '--no-auth と --allow-host の併用を許すと、黙って無認証でトンネルに出る',
        file: 'v0/server.mjs',
        from: 'if (opts.requireAuth === false && opts.allowHosts.size > 0) {',
        to: 'if (false) {',
        gone: 'opts.requireAuth === false && opts.allowHosts.size > 0',
        pattern: '併用は起動を拒否する',
    },
    // 5回目のレビューの BLOCKING 2件（どちらも直前の修正による回帰）
    {
        // 🚨 6回目のレビュー: この門は自動生成より**後**にあったので、
        //    `--allow-host`（requireAuth を自動オン）を並べると消えていた
        name: 'exec-token-explicit',
        why: '実行の門を「明示的に決めたか」ではなく長さだけで見る'
            + '（requireAuth の自動生成トークン 43 文字が条件を満たす）',
        // ⚠️ **門を自動生成より前に置いた今は冗長。** その位置では `opts.token` は
        //    `--token` / `--token-file` でしか埋まらないので、長さの検査だけでも同じ結果になる。
        //    残す理由: **本体の守りは「順序」**で、順序が戻ったときにこれが第二の砦になる
        //    （順序そのものは `exec-token-gate-order` が測っている）。
        defensive: '門が自動生成より前にある限り冗長（その位置では token は明示でしか埋まらない）。'
            + '順序が戻ったときに効く第二の砦として残す。順序は exec-token-gate-order が測る',
        file: 'v0/server.mjs',
        from: 'if (opts.allowExec && (!opts.tokenExplicit || !opts.token || opts.token.length < 24)) {',
        to: 'if (opts.allowExec && (!opts.token || opts.token.length < 24)) {',
        gone: '!opts.tokenExplicit',
        pattern: '自動生成では通さない',
    },
    {
        name: 'exec-token-gate-order',
        why: '実行の門を自動生成より後ろに戻す（同じ穴が順序で復活する）',
        file: 'v0/server.mjs',
        from: `if (opts.allowExec && (!opts.tokenExplicit || !opts.token || opts.token.length < 24)) {`,
        to: `if (opts.requireAuth && !opts.token) opts.token = randomBytes(32).toString('base64url');
if (opts.allowExec && (!opts.token || opts.token.length < 24)) {`,
        gone: 'if (opts.allowExec && (!opts.tokenExplicit',
        pattern: '自動生成では通さない',
    },
    {
        name: 'token-url-for-write-exec',
        why: '書き込み・実行を有効にしてもトークン付き URL を表示しない'
            + '（ブラウザが入手する経路が無いので UI から必ず 403。有効に見えて動かない）',
        file: 'v0/server.mjs',
        from: '    if (opts.requireAuth || opts.allowWrite || opts.allowExec) {',
        to: '    if (opts.requireAuth) {',
        gone: 'opts.requireAuth || opts.allowWrite || opts.allowExec',
        pattern: 'ブラウザがトークンを入手できる経路がある',
    },
    {
        name: 'stream-detach-if-gone',
        why: '応答が届く前に切られた場合を検知しない'
            + '（購読者が永久に残り、切断後の猶予が完全に無効化される）',
        file: 'v0/server.mjs',
        // ⚠️ `req.destroyed` を混ぜた版で書いていたので SKIP になっていた（守りが
        //    未検証のまま静かに残る）。**SKIP を緑と読まない**（CLAUDE.md）
        from: '    if (res.destroyed) detach();',
        to: '    /* 変異: 既に切られている場合を見ない */',
        gone: 'if (res.destroyed) detach()',
        pattern: '応答が届く前に切っても切断として扱い',
    },
    // L3 #2: 判定できないものを「衝突する」と言わない
    {
        name: 'submodule-undecidable',
        why: 'submodule の衝突を「判定できない」ではなく「衝突する」として出す'
            + '（git 自身が trivial なケースしか対応しないと言っている）',
        file: 'v0/git.mjs',
        from: '        if (/submodule/i.test(kind)) {',
        to: '        if (false) {',
        gone: 'if (/submodule/i.test(kind)) {',
        pattern: 'submodule は「衝突する」ではなく',
    },
    {
        name: 'mergeplan-unknown-not-conflict',
        why: 'clean=null（不明）を衝突として扱う（判定できないペアを「衝突する」と提示する嘘）',
        file: 'v0/mergeplan.mjs',
        from: '        } else if (c.clean === false) {\n            tested++;',
        to: '        } else {\n            tested++;',
        gone: '} else if (c.clean === false) {',
        pattern: '「衝突する」と提示しない',
        testFile: 'v0/mergeplan.test.mjs',
    },
    // L3 #1 / #4: 「開けないものを普通に出す」「別のものを同じ見た目で並べる」
    {
        name: 'conflict-synthetic-path',
        why: 'merge-tree の退避名（実在しないパス）を普通のファイル名として出す'
            + '（押しても開けない行き止まりになる）',
        file: 'v0/git.mjs',
        from: "        synthetic.set(toNFC(m[2].trim()), toNFC(m[1].trim()));",
        to: '        /* 変異: 退避名を拾わない */',
        gone: 'synthetic.set(toNFC(m[2].trim())',
        // ⚠️ 構造からも取るようになったので、メッセージ側だけ外しても
        //    file/directory は検出できる。**両方外して守り全体を測る。**
        also: [{
            from: `        if (count === 2) {
            const [p, q] = paths;
            if (p.startsWith(\`\${q}~\`)) synthetic.set(p, q);
            else if (q.startsWith(\`\${p}~\`)) synthetic.set(q, p);
        }`,
            to: '        /* 変異: 構造からも拾わない */',
        }],
        pattern: '合成パスを印付けて',
    },
    {
        // 🚨 symlink 対 file は**メッセージに退避名が出ない**ので、構造からしか取れない
        name: 'conflict-synthetic-structural',
        why: '情報レコードの構造から退避名を取らない'
            + '（symlink 対 file = CONFLICT (distinct types) は '
            + '`moving it to X instead` と言わないので、合成パスが印無しで出る）',
        file: 'v0/git.mjs',
        from: `        if (count === 2) {
            const [p, q] = paths;
            if (p.startsWith(\`\${q}~\`)) synthetic.set(p, q);
            else if (q.startsWith(\`\${p}~\`)) synthetic.set(q, p);
        }`,
        to: '        /* 変異: 構造から拾わない */',
        gone: 'if (p.startsWith(`${q}~`))',
        pattern: 'symlink 対 file の合成パスにも印が付く',
    },
    // #33: bare / prunable の門。以前は**本物の bare を作っていなかった**ので
    //      4つとも外しても全テストが緑だった（過去2件と同じクラスの偽陽性）。
    {
        name: 'exec-bare-gate',
        why: 'bare worktree を cwd にできる（作業ツリーの無い場所で任意コマンドが走る）',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { bail(400, 'bare worktree では実行できません'); return; }",
        to: '            /* 変異: bare の門を外す */',
        gone: "bail(400, 'bare worktree では実行できません')",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'exec-prunable-gate',
        why: '実体の消えた worktree を cwd にできる（ENOENT で経路が壊れる）',
        file: 'v0/server.mjs',
        from: "            if (wt.prunable) { bail(409, '作業ツリーが失われています'); return; }",
        to: '            /* 変異: prunable の門を外す */',
        gone: "bail(409, '作業ツリーが失われています')",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'checkout-bare-gate',
        why: 'bare worktree で checkout を通す（作業ツリーが無いので必ず壊れる）',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }",
        to: '            /* 変異: bare の門を外す */',
        gone: "'bare worktree では checkout できません'",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'checkout-prunable-gate',
        why: '実体の消えた worktree で checkout を通す',
        file: 'v0/server.mjs',
        // 🚨 **同じ門が merge にもできたので、字面を一意にする。**
        //    `String.replace` は最初の1件しか置換しないので、merge 側が
        //    書き換わって checkout の門は無傷のまま「gone が残る」で STALE になっていた
        //    （`--dry` で見つけた。守りは1件も検証されていなかった）。
        from: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }\n"
            + "            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }",
        to: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }",
        gone: "checkout できません'); return; }\n            if (wt.prunable)",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'merge-prunable-gate',
        why: '実体の消えた worktree に取り込む（cwd にできないので経路が壊れる）'
            + '。checkout と同じ門を後から足したのに検査が1件も無かった',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では取り込めません'); return; }\n"
            + "            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }",
        to: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では取り込めません'); return; }",
        gone: "取り込めません'); return; }\n            if (wt.prunable)",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'repo-accepts-bare',
        why: 'bare リポジトリを開けなくする（bare を親に worktree を並べる構成が使えない。'
            + 'かつ bare の門が到達不能になって検証できなくなる）',
        file: 'v0/server.mjs',
        // ⚠️ `--repo` を複数受けるようにしてループの中に入ったのでインデントが増えた
        from: "            try { top = (await git(['rev-parse', '--show-toplevel'], { cwd: given })).trim(); }\n            catch { /* bare。下で判定する */ }",
        to: "            top = (await git(['rev-parse', '--show-toplevel'], { cwd: given })).trim();",
        gone: 'catch { /* bare。下で判定する */ }',
        pattern: 'bare と prunable の門が実際に効く',
    },
    // 4回目のレビューの SERIOUS 4件（issue #26-#28, #32）
    {
        name: 'input-total-limit',
        why: '標準入力の総量を縛らない（相手が読まないと親のメモリに無限に溜まる）',
        file: 'v0/server.mjs',
        from: '                    if (s.inputBytes + bytes > limits.inputTotalBytes) {',
        to: '                    if (false) {',
        gone: 's.inputBytes + bytes > limits.inputTotalBytes',
        // 滞留の上限（1MB）が先に効くので、単独では落ちない可能性がある。
        // 両方外して「上限が全く無い」状態を測る
        also: [{
            from: '                    if (pending > limits.inputPendingBytes) {',
            to: '                    if (false) {',
        }],
        pattern: '標準入力の総量と滞留に上限がある',
    },
    {
        name: 'transcript-adaptive-tail',
        why: '巨大な1レコードで完全な行が0本になったとき読み直さない'
            + '（稼働中のエージェントに「記録がありません」と表示する嘘）',
        file: 'v0/transcript.mjs',
        from: '            needMore: complete === 0 && len < size,',
        to: '            needMore: false,',
        gone: 'complete === 0 && len < size',
        pattern: '巨大な1レコードでも読み直して',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-too-big-honest',
        why: '上限まで読んでも取れなかったことを伝えない（黙って「記録なし」になる）',
        file: 'v0/transcript.mjs',
        from: '        s.tooBigToRead = tail.tooBigToRead === true;',
        to: '        s.tooBigToRead = false;',
        gone: 'tail.tooBigToRead === true',
        pattern: '読めなかった」と伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-subagents',
        why: 'サブエージェントの活動を数えない'
            + '（親の追記が止まるので、稼働中を「待機」と表示する嘘）',
        file: 'v0/transcript.mjs',
        from: '        const sub = await subagentActivity(newest.path, {',
        to: '        const sub = null && await subagentActivity(newest.path, {',
        gone: '        const sub = await subagentActivity',
        pattern: 'サブエージェントの活動を数え',
        testFile: 'v0/transcript.test.mjs',
    },
    // 4回目のレビューの SERIOUS 3件（issue #23-#25）
    {
        name: 'cookie-decode-crash',
        why: '壊れた Cookie（`kjp_auth=%`）1本で認可の手前に URIError が飛び、'
            + 'デーモンが exit 1 で落ちる（無認証で撃てる DoS）',
        file: 'v0/server.mjs',
        from: '        try { out.push(decodeURIComponent(v)); } catch { out.push(v); }',
        to: '        out.push(decodeURIComponent(v));',
        gone: 'try { out.push(decodeURIComponent(v)); }',
        // ⚠️ 外側の catch-all も守っているので、単独では落ちない可能性がある。
        //    両方外して守り全体を測る。
        // 🚨 **以前の書き方は無効だった。** `.catch(err => { throw err; }).catch(本体)` は
        //    直後の catch が再捕捉するので catch-all は外れておらず、
        //    「両方外して測る」というコメント自体が事実と違っていた（#42）。
        //    catch の**中身**を rethrow に置き換える。
        also: [{
            from: "        console.error('⚠ 要求の処理で例外（デーモンは継続します）:', err);",
            to: '        throw err;   /* 変異: catch-all を無効化 */',
        }],
        pattern: '壊れた Cookie / ヘッダでデーモンが落ちない',
    },
    {
        // 🚨 #42: 汎用の砦そのものを外す。以前は検査が1つも無く、丸ごと消しても全緑だった
        name: 'handler-catch-all',
        why: 'ハンドラの例外を捕まえる最後の砦を外す'
            + '（unhandled rejection でデーモンが exit 1。走っている全セッションが消える）',
        file: 'v0/server.mjs',
        from: "        console.error('⚠ 要求の処理で例外（デーモンは継続します）:', err);",
        to: '        throw err;   /* 変異: 砦を無効化 */',
        gone: 'デーモンは継続します',
        pattern: 'ハンドラが throw しても 500 を返して',
    },
    {
        name: 'handler-error-leak',
        why: '例外のメッセージをクライアントに返す'
            + '（内部のパスや git の出力が、認証を通っていない相手にも渡る）',
        file: 'v0/server.mjs',
        from: "        res.end(JSON.stringify({ error: 'internal error' }));\n    }\n}",
        to: '        res.end(JSON.stringify({ error: String(err && err.message || err) }));\n    }\n}',
        gone: "res.end(JSON.stringify({ error: 'internal error' }));\n    }\n}",
        pattern: 'ハンドラが throw しても 500 を返して',
    },
    {
        name: 'exec-subscriber-backpressure',
        why: '読まない購読者に無制限に溜める（RSS 72MB→433MB を実測）',
        file: 'v0/server.mjs',
        from: '        if (res.writableLength > MAX_PENDING_BYTES) {',
        to: '        if (false) {',
        gone: 'res.writableLength > MAX_PENDING_BYTES',
        pattern: '読まない購読者は切られ',
    },
    {
        name: 'exec-evict-with-subscribers',
        why: '購読者が残っていると終了済みセッションを永久に消さない'
            + '（詰まったソケット1つでメモリが溜まり続ける）',
        file: 'v0/execsession.mjs',
        from: '            if (now - doneAt >= this.limits.retainMs) evict.push(s);',
        to: '            if (now - doneAt >= this.limits.retainMs && !s.subscribers.size) evict.push(s);',
        gone: 'this.limits.retainMs) evict.push(s);',
        pattern: '保持期間を過ぎたら購読者がいても消す',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-attach-after-finish',
        why: '終わったセッションを running に戻す'
            + '（「停止した」後に走り続け、枠が二重に返る）',
        file: 'v0/execsession.mjs',
        from: '        if (!s.running) return false;\n        s.child = child;',
        to: '        s.child = child;',
        gone: 'if (!s.running) return false;\n        s.child',
        pattern: 'attachChild は終わったセッションを running に戻さない',
        testFile: 'v0/execsession.test.mjs',
    },
    // 4回目のレビュー（並列・独立）で見つかった BLOCKING 4件。
    // docs/review-4-parallel.md / issue #19-#22
    {
        name: 'session-token-to-cookie-auth',
        why: 'Cookie 認証の要求に実行トークンを返す。Cookie はポートで分離されないので、'
            + '他ポートを開いた相手がリクエスト1本多いだけで任意コード実行に到達する（実測）',
        file: 'v0/server.mjs',
        from: '                token: opts.allowWrite && sameOrigin && shown.ok\n                    ? opts.token : null,',
        to: '                token: opts.allowWrite && sameOrigin ? opts.token : null,',
        // ⚠️ `presentedToken(` は関数定義側にも出るので、呼び出しの形で一意にする
        gone: 'sameOrigin && shown.ok',
        pattern: 'Cookie の値は実行トークンと別で',
    },
    // spawn 失敗（'exit' が来ない）と孫が stdio を握る場合（'close' が来ない）を
    // **2つのハンドラで両側から**塞いでいる。どちらが load-bearing かを個別に測る。
    // ⚠️ `close` 側と `error` 側は**どちらも単独で ENOENT を終端できる**ので、
    //    片方ずつ外しても落ちない（実測で確認）。それは「テストの穴」ではなく
    //    「守りが二重」なので、**両方を外す変異**で守り全体を測る。
    //    2つある理由は失敗の形が2つあること: spawn 失敗は 'exit' が来ない、
    //    孫が stdio を握ると 'close' が来ない。
    {
        name: 'exec-spawn-terminate',
        why: "spawn の非同期失敗（ENOENT）を終端する経路が両方無くなると、"
            + 'セッションが永久に running になり枠も返らない'
            + '（起動していないプロセスを「実行中」と表示する嘘）',
        file: 'v0/server.mjs',
        from: `            child.on('close', () => {
                if (execRegistry.finish(session, { code: null, signal: null,`,
        to: `            child.on('close', () => {
                if (false && execRegistry.finish(session, { code: null, signal: null,`,
        also: [{
            from: '                if (execRegistry.finish(session, { code: null, signal: null })) {',
            to: '                if (false) {',
        }],
        gone: "child.on('close', () => {\n                if (execRegistry.finish",
        pattern: '起動できないコマンドでもセッションが終端し',
    },
    {
        name: 'exec-exit-finish',
        why: "'exit' で終端しない。正常終了の終了コードが取れなくなる"
            + "（'close' の保険に落ちて code:null になる）",
        file: 'v0/server.mjs',
        from: '                if (execRegistry.finish(session, { code, signal })) {',
        to: '                if (false) {',
        gone: 'execRegistry.finish(session, { code, signal })',
        pattern: 'exec が出力を流し、終了コードを返す',
    },
    {
        name: 'exec-spawn-error-note',
        why: 'spawn 失敗の理由を出さない（何が起きたか分からない）',
        // 終端そのものは 'close' が担うので、この行は理由の告知が本体。
        // 冗長ではなく役割が違うことを記録しておく。
        defensive: '終端は close が担う。この行は「なぜ起動できなかったか」の告知',
        file: 'v0/server.mjs',
        from: '                if (execRegistry.finish(session, { code: null, signal: null })) {',
        to: '                if (false) {',
        gone: 'execRegistry.finish(session, { code: null, signal: null })) {',
        pattern: '起動できないコマンドでもセッションが終端し',
    },
    {
        name: 'stdin-error-listener',
        why: 'child.stdin の error を拾わない（EPIPE で uncaught → デーモンが落ちる）',
        file: 'v0/server.mjs',
        from: "            child.stdin?.on('error', err => {",
        to: '            if (false) (err => {',
        gone: "child.stdin?.on('error'",
        pattern: '相手が終わった直後に標準入力へ送っても',
    },
    {
        // 🚨 8回目のレビュー: stdin と同じ型の兄弟経路が取りこぼされていた。
        name: 'exec-child-error-listener',
        why: "spawn した子の 'error' を拾わない"
            + '（ENOENT が uncaughtException になりデーモンが exit 1 で落ちる）',
        file: 'v0/server.mjs',
        from: "            child.on('error', async err => {",
        to: '            if (false) (async err => {',
        gone: "child.on('error', async err => {",
        pattern: '起動できないコマンドでもセッションが終端し',
    },
    {
        /**
         * 🚨 **順序そのものを測る。** listener が「存在する」ことと
         *    「早期 return より前に張られている」ことは別で、後者が守りの本体。
         *    `attachChild` が false の経路（starting のうちに kill された回）では、
         *    後ろに張っていると listener 無しの ChildProcess が残り ENOENT で即死する。
         * ⚠️ 移した先の登録は**わざと二重引用符**にしてある。同じ字面のままだと
         *    `gone` が書き換え後も残り「置換が効いていない」と誤判定される（SKIP/STALE）。
         */
        name: 'exec-child-error-after-attach',
        why: "spawn した子の 'error' を早期 return の後ろで張る"
            + '（starting のうちに kill された回だけ listener が無くなり、'
            + 'ENOENT でデーモンが落ちる。実測で exec 1本 + kill 1本で消えた）',
        file: 'v0/server.mjs',
        from: "            child.on('error', async err => {\n"
            + "                execRegistry.emit(session, 'err', `実行エラー: ${err.message}`);\n",
        to: "            if (false) (async err => {\n"
            + "                execRegistry.emit(session, 'err', `実行エラー: ${err.message}`);\n",
        // ⚠️ **挿入位置は「早期 return の直後にある1行」に固定する。**
        //    以前は attachChild のブロックを丸ごと書いていたので、
        //    ブロックの中身を1行足しただけで STALE になった（守りが未検証になる）。
        also: [{
            from: '            // 🚨 **`killRequested` が立っているセッションに子を渡したままにしない。**\n',
            to: '            // 🚨 変異: error の listener を早期 return の後ろに移す\n'
                + '            child.on("error", async err => {\n'
                + "                execRegistry.emit(session, 'err', `実行エラー: ${err.message}`);\n"
                + '                if (execRegistry.finish(session, { code: null, signal: null })) {\n'
                + '                    await auditExec({\n'
                + '                        event: \'exit\', session: session.id, worktree: wt.path, argv,\n'
                + '                        code: null, signal: null, note: `spawn 失敗: ${err.message}`,\n'
                + '                    });\n'
                + '                }\n'
                + '            });\n',
        }],
        gone: "child.on('error', async err => {",
        pattern: 'starting のうちに kill された後に spawn',
    },
    {
        name: 'transcript-string-content',
        why: 'user の文字列 content から本文を出す'
            + '（ツールの結果と形で区別できないので T5 が漏れる）',
        file: 'v0/transcript.mjs',
        from: "            if (typeof content === 'string' && r.type === 'user') out.talk++;",
        to: "            if (typeof content === 'string' && r.type === 'user') {\n"
            + '                out.talk++;\n'
            + '                if (allowText && out.text.length < limits.maxText) {\n'
            + '                    const t = clip(content, limits.textChars);\n'
            + "                    if (t) out.text.push({ at, role: 'user', text: t });\n"
            + '                }\n'
            + '            }',
        gone: "if (typeof content === 'string' && r.type === 'user') out.talk++;",
        pattern: '文字列の content は allowText でも本文を出さない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'auth-cookie-is-exec-token',
        why: 'Cookie に実行トークンをそのまま入れる。'
            + 'Cookie はポートで分離されないので、同じブラウザで開いた他のローカル'
            + 'サービスに実行トークンが渡り、任意コマンドを実行できる',
        file: 'v0/server.mjs',
        // ⚠️ #43 で `readCookie` → `readCookies`（全部返す）にしたので字面が変わった
        from: '    return readCookies(req, AUTH_COOKIE).some(v => secretMatches(v, cookieSecret()))',
        to: '    return readCookies(req, AUTH_COOKIE).some(v => tokenMatches(v))',
        gone: 'some(v => secretMatches(v, cookieSecret()))',
        pattern: 'Cookie の値は実行トークンと別で',
    },
    {
        name: 'exec-bail-on-prepare-error',
        why: '準備（worktree 一覧）の失敗を bail に通さない'
            + '（枠が返らず 8 回で恒久的に 429。再起動しか回復手段が無い #35）',
        file: 'v0/server.mjs',
        from: '                bail(500, `実行の準備に失敗しました: ${err.message}`);',
        to: '                throw err;   /* 変異: 枠を返さず外の catch-all に投げる */',
        gone: 'bail(500, `実行の準備に失敗しました',
        pattern: '準備に失敗しても枠を返す',
    },
    {
        name: 'exec-sweeper-early',
        why: '回収機構の起動を「過去に1本成功したか」に依存させる（#35）',
        // ⚠️ bail を直した今、**枠の回収は sweeper に依存していない**（finish が返す）。
        //    残る差は「終了済みセッションの台帳からの追い出し」で、
        //    `retainMs = 10分` 経ってからしか観測できないので安く測れない。
        //    それでも前に出しておく: 回収の有無が過去の成功に依存する形は、
        //    別の失敗経路を足した瞬間に**恒久 429** に戻る（実際にそうなっていた）。
        defensive: '枠は finish が返すので現状は保険。'
            + '追い出しの差は retainMs=10分 後にしか出ず安く測れない。'
            + '失敗経路を足したときに恒久 429 へ戻らないための前出し',
        file: 'v0/server.mjs',
        from: '            startExecSweeper();\n\n            // 予約した後の失敗経路は必ず枠を返す',
        to: '            // 予約した後の失敗経路は必ず枠を返す',
        gone: '            startExecSweeper();\n\n',
        pattern: '準備に失敗しても枠を返す',
    },
    {
        name: 'token-file-worktrees',
        why: '全 worktree を見ずにメインの top だけで判定する'
            + '（linked worktree に置かせて、エージェントの git add -A でコミットされる #39）',
        file: 'v0/server.mjs',
        // ⚠️ 判定を `insideRepoGate()` に集約し、さらに全リポジトリを回すループに
        //    入れたのでインデントが変わった（--dry で検出）
        from: '            for (const w of await listWorktrees(r0)) if (w.path) roots.push(w.path);',
        to: '            /* 変異: worktree を見ない */',
        gone: 'if (w.path) roots.push(w.path)',
        pattern: 'linked worktree と bare の中も拒否する',
    },
    {
        name: 'token-file-common-dir',
        why: '.git 本体（bare のリポジトリ自身を含む）を見ない',
        // ⚠️ 現在の実装では冗長。`listWorktrees()` は bare の worktree レコードも
        //    返し、`.git` はメイン worktree の中にあるので、どちらも worktree 一覧で
        //    捕まる（実測: この行を外しても bare / .git の拒否は落ちない）。
        //    それでも残す理由: **`worktree list` が失敗したときの唯一の根**になる。
        //    無いと roots が空になり `unknown`（判定できない）に落ちて素通りする。
        defensive: 'listWorktrees() が bare も .git の親も返すので現状は二重。'
            + 'worktree list が失敗したときに roots を空にしない（unknown に落とさない）ための根として残す',
        file: 'v0/server.mjs',
        // ⚠️ 判定を `insideRepoGate()` に集約し、さらに全リポジトリを回すループに
        //    入れたのでインデントが変わった（--dry で検出）。
        //    ⚠️ commonDir は gitDirs にも積むようになった（監査ログの「.git の中は許す」
        //    判定がこれを使う）ので、外すと監査ログの門も落ちる。
        from: `            const common = (await commonDir(r0)).trim();
            if (common) { roots.push(common); gitDirs.push(common); }`,
        to: '            /* 変異: .git を見ない */',
        gone: 'if (common) roots.push(common)',
        pattern: 'linked worktree と bare の中も拒否する',
    },
    {
        name: 'auth-cookie-first-only',
        why: '同名 Cookie の先頭1本しか見ない（他ポートのページが `path=/api/v0` に junk を焼くと'
            + '**手で消すまで 401**。焼き直しは Path=/ なので上書きできない）',
        file: 'v0/server.mjs',
        from: '    return readCookies(req, AUTH_COOKIE).some(v => secretMatches(v, cookieSecret()))',
        to: '    return secretMatches(readCookies(req, AUTH_COOKIE)[0], cookieSecret())',
        gone: '.some(v => secretMatches(v, cookieSecret()))',
        pattern: '他ポートが焼いた同名 Cookie を先頭に置かれても締め出されない',
    },
    {
        name: 'auth-cookie-samesite',
        why: 'Cookie の SameSite / HttpOnly を外す（CSRF と JS からの読み取りに開く）',
        file: 'v0/server.mjs',
        from: "            + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000');",
        to: "            + '; Path=/; Max-Age=31536000');",
        gone: 'HttpOnly; SameSite=Strict',
        pattern: '読み取り用の Cookie を焼き、ページ本体を返す',
    },
    {
        // ⚠️ リダイレクトをやめたので、URL からトークンを消すのは**ページ側**の仕事に移った
        //    （4回目のレビュー: 302 だと JS がトークンを見られず、Cookie から
        //     取り戻す作りになって RCE の穴になっていた）。変異先も app.html に移す。
        name: 'auth-token-not-in-url',
        why: 'ページが URL からトークンを消さない（履歴と Referer に残る）',
        file: 'v0/app.html',
        from: "    history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);",
        to: '    /* 変異: URL からトークンを落とさない */',
        gone: 'history.replaceState',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'auth-token-in-session-storage',
        why: 'トークンを sessionStorage に持たない。'
            + 'Cookie 経由でしか取り戻せなくなり、他ポートの相手が実行に到達する',
        file: 'v0/app.html',
        from: '    try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* 使えない環境 */ }',
        to: '    /* 変異: トークンを保持しない */',
        gone: 'sessionStorage.setItem(TOKEN_KEY, t)',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 **行を消さずに到達不能にする変異。** #41 の本題はこれ。
        //    以前の smoke は JS の**字面**しか見ていなかったので、
        //    `if (false && t)` で囲むだけの変更が完全に見えなかった。
        name: 'auth-token-bootstrap-unreachable',
        why: 'トークンの取り込みを到達不能にする（行は残るので字面の検査では見えない）',
        file: 'v0/app.html',
        from: '  const t = u.searchParams.get(\'token\');\n  if (t) {',
        to: '  const t = u.searchParams.get(\'token\');\n  if (false && t) {',
        gone: "get('token');\n  if (t) {",
        script: 'v0/render-check.mjs',
    },
    // ---- 運用スクリプトの門（#45。ここには変異が1件も無かった）----
    // 🚨 これらの守りは落ちても**手元では気付けない**形で壊れる:
    //    `--allow-host` を落とすと**再起動後だけ 403**、観測フラグを落とすと
    //    **ログオン後だけパネルが消える**。だから変異で固定する。
    {
        name: 'serve-unknown-flag',
        why: '知らないオプションを黙って捨てる（--allow-write を渡した人に「読み取り専用」と表示していた #30）',
        file: 'scripts/serveargs.mjs',
        from: "        if (!a.startsWith('-') || known.has(a)) continue;",
        to: '        continue;',
        gone: 'known.has(a)',
        pattern: '知らないオプションは黙って捨てずに止める',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-value-skip',
        why: '値をフラグとして検査する（--port -1 を「知らないオプション」と誤報して原因から目を逸らす）',
        file: 'scripts/serveargs.mjs',
        from: '        if (VALUE_FLAGS.has(a)) { i++; continue; }',
        to: '        /* 変異: 値を飛ばさない */',
        gone: 'VALUE_FLAGS.has(a)',
        pattern: '知っているオプションと値は未知として報告しない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-port-range',
        why: '--port の範囲検証を外す（0 や 65536 で起動して失敗の理由が分からなくなる）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: String(raw) };',
        to: '    /* 変異: 範囲を見ない */',
        gone: 'n > 65535',
        pattern: '--port は範囲外と非数値を拒否する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-host-validate',
        why: 'ホスト名の形の検証を外す（Run キーの1つの文字列の中で別の引数に化ける #29）',
        file: 'scripts/serveargs.mjs',
        from: "    if (!h || !/^[A-Za-z0-9._-]+$/.test(h)) return { error: h ?? null };",
        to: '    if (!h) return { error: h ?? null };',
        gone: 'A-Za-z0-9._-',
        pattern: '--allow-host はホスト名の形だけ通す',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-host-forward',
        why: '--allow-host をサーバに引き継がない（**再起動後だけ 403**。手元では気付けない）',
        file: 'scripts/serveargs.mjs',
        from: "    for (const h of hosts) args.push('--allow-host', h);",
        to: '    /* 変異: 引き継がない */',
        gone: "for (const h of hosts) args.push",
        pattern: '--allow-host は値ごとサーバに引き継ぐ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-watch-forward',
        why: '観測フラグをサーバに引き継がない（**ログオン後だけパネルが消える**）',
        file: 'scripts/serveargs.mjs',
        from: `    if (has('--agents-text')) args.push('--watch-agents', '--allow-transcript-text');
    else if (has('--watch')) args.push('--watch-agents');`,
        to: '    /* 変異: 観測フラグを引き継がない */',
        gone: "args.push('--watch-agents', '--allow-transcript-text')",
        pattern: '観測フラグを引き継ぐ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-exec-implies-write',
        why: '--exec が --write を含まなくなる（実行はできるのに checkout が 403 になる）',
        file: 'scripts/serveargs.mjs',
        from: "    const wantWrite = wantExec || has('--write');",
        to: "    const wantWrite = has('--write');",
        gone: "wantExec || has('--write')",
        pattern: '--exec は --write を含むが',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-audit-log',
        why: '実行を許すのに監査ログを付けない（何が走ったか後から分からない）',
        file: 'scripts/serveargs.mjs',
        from: "    if (auditLog) args.push('--audit-log', auditLog);\n",
        to: '',
        gone: "args.push('--audit-log', auditLog)",
        pattern: '--exec は --write を含むが',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 7回目のレビュー: 分けたのは exec だけで、write が read を使い回していた
        name: 'serve-token-write-separate',
        why: '--write --allow-host が読み取り用トークンを使い回す'
            + '（読み取り用として配った値が checkout の資格情報になる）',
        file: 'scripts/serveargs.mjs',
        from: '    const file = wantExec ? execTokenFile : (wantWrite ? writeTokenFile : tokenFile);',
        to: '    const file = wantExec ? execTokenFile : tokenFile;',
        gone: 'wantWrite ? writeTokenFile : tokenFile',
        pattern: '読み取り用トンネルと実行でトークンのファイルを分ける',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-running-caps',
        why: '動いているデーモンの capability を読めなくする'
            + '（先に --exec のデーモンが動いていると、読み取り専用のつもりの起動が'
            + 'RCE 可能なデーモンの URL を黙って案内する）',
        file: 'scripts/serveargs.mjs',
        from: "    const tokens = new Set(String(cmd ?? '').split(/\\s+/));\n"
            + "    return ['--allow-exec', '--allow-write', '--watch-agents', '--allow-transcript-text',\n"
            + "        '--allow-host'].filter(f => tokens.has(f));",
        to: '    return [];',
        gone: 'tokens.has(f)',
        pattern: '動いているデーモンの capability を読める',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-token-separate',
        why: '読み取り用トンネルと実行で同じトークンファイルを使う'
            + '（読み取り用の URL をスマホで開くことが実行トークンを配ることになる。6回目のレビュー）',
        file: 'scripts/serveargs.mjs',
        // ⚠️ write を3段目に足したので字面が変わった（7回目のレビュー）
        from: '    const file = wantExec ? execTokenFile : (wantWrite ? writeTokenFile : tokenFile);',
        to: '    const file = wantWrite ? writeTokenFile : tokenFile;',
        gone: 'wantExec ? execTokenFile',
        pattern: '読み取り用トンネルと実行でトークンのファイルを分ける',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-token-persist',
        why: 'トークンを永続化しない（遠隔から使えず「楽な場所に置く」方向へ流れる）',
        file: 'scripts/serveargs.mjs',
        // ⚠️ トークンを読み取り用と実行用に分けたので字面が変わった（6回目のレビュー）
        from: "    if ((hosts.length > 0 || wantExec) && file) args.push('--token-file', file);",
        to: '    /* 変異: 永続化しない */',
        gone: "args.push('--token-file', file)",
        pattern: '実行とトンネルはトークンを永続化する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 純関数を全部テストしても「呼んでいない」は検出できないので、配線も外す
        name: 'serve-calls-gate',
        why: 'serve.mjs が未知フラグの門を呼ばない（純関数は緑のままだが打ったフラグが効かない）',
        file: 'scripts/serve.mjs',
        from: "    const bad = unknownFlag(argv, SERVE_FLAGS, 'この起動口');",
        to: '    const bad = null;',
        gone: 'unknownFlag(argv, SERVE_FLAGS',
        pattern: 'serve.mjs は知らないオプションで起動せずに止まる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'autostart-calls-gate',
        why: 'autostart.mjs が未知フラグの門を呼ばない（壊れた登録がそのまま Run キーに入る）',
        file: 'scripts/autostart.mjs',
        from: "    const bad = unknownFlag(argv, AUTOSTART_FLAGS, 'このスクリプト');",
        to: '    const bad = null;',
        gone: 'unknownFlag(argv, AUTOSTART_FLAGS',
        pattern: 'autostart.mjs は知らないオプションで登録せずに止まる',
        testFile: 'scripts/serveargs.test.mjs',
        platforms: ['win32'],
    },
    {
        name: 'autostart-forward',
        why: '自動起動の登録が --allow-host と観測フラグを引き継がない（c0948ea の回帰）',
        file: 'scripts/serveargs.mjs',
        from: `    for (const h of hosts.hosts) args.push('--allow-host', h);
    if (has('--agents-text')) args.push('--agents-text');
    else if (has('--watch')) args.push('--watch');`,
        to: '    /* 変異: 登録に引き継がない */',
        gone: "args.push('--agents-text')",
        pattern: '自動起動は capability と引き継ぎを',
        testFile: 'scripts/serveargs.test.mjs',
    },
    // ---- 実行の絶対上限（--timeout）と「既に動いています」の差分、--stop の対象 ----
    // 🚨 8回目のレビュー: `--timeout` は純関数を全部テストしていたのに
    //    **serve.mjs がそれを渡していることを誰も見ていなかった**（1行消しても 24 テスト
    //    全部緑・変異0件）。差分の門は capability の**名前**しか比べておらず、
    //    `--stop` はマシン上の全デーモンを止めるのに repo を出していなかった。
    {
        name: 'serve-exec-timeout-forward',
        why: 'serverArgs が --exec-timeout を組み立てない（--timeout を打っても 600 秒のまま）',
        file: 'scripts/serveargs.mjs',
        from: "            args.push('--exec-timeout', String(execTimeout));",
        to: '            /* 変異: 上限を渡さない */',
        gone: "args.push('--exec-timeout'",
        pattern: '--timeout で絶対上限をサーバに渡す',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 これが指摘の本体。**純関数を全部テストしても「呼んでいない」は見えない**
        name: 'serve-passes-exec-timeout',
        why: 'serve.mjs が上限をサーバに渡さない'
            + '（serve.mjs --exec --timeout 3600 が黙って 600 秒で起動し、'
            + '「回答が書かれる直前に SIGKILL」が復活する）',
        file: 'scripts/serve.mjs',
        from: '    execTimeout: timeoutCheck.seconds,',
        to: '    /* 変異: 上限を渡さない */',
        gone: 'execTimeout: timeoutCheck.seconds',
        pattern: 'serve.mjs の --timeout が実際にサーバに届く',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-timeout-value-missing',
        why: '--timeout の値が無い形を既定に落とす（延ばしたつもりで 600 秒のまま起動）',
        file: 'scripts/serveargs.mjs',
        // ⚠️ `portFrom()` に同じ形の行ができたので、**後ろの行まで含めて一意にする**
        //    （`gone` が同じ式だと「他所にできた瞬間に無効化される」の再発）
        from: "    if (raw === undefined || String(raw).startsWith('-')) return { error: raw ?? '(無し)' };\n    return checkTimeout(raw);",
        to: '    return checkTimeout(raw);   /* 変異: 値が無い形を見ない */',
        gone: "return { error: raw ?? '(無し)' };\n    return checkTimeout(raw);",
        pattern: '--timeout の値が無い形を既定に落とさない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-timeout-value-gate',
        why: 'serve.mjs が --timeout の値を検証しない（壊れた値が黙って既定になる）',
        file: 'scripts/serve.mjs',
        from: `if (timeoutCheck.error !== undefined) {
    console.error(\`\\n✖ --timeout には 10〜86400（秒）を指定してください\`
        + \`（受け取った値: \${timeoutCheck.error}）\`);
    console.error('  上限そのものは外せません（取り残しの唯一の歯止めなので）。\\n');
    process.exit(1);
}`,
        to: '/* 変異: 値を検証しない */',
        gone: '--timeout には 10〜86400',
        pattern: '--timeout が効かない組み合わせを黙って捨てない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-timeout-needs-exec',
        why: '--exec 無しの --timeout を黙って捨てる（打った上限が効かないことが分からない）',
        file: 'scripts/serve.mjs',
        from: `    console.log('⚠ --timeout は --exec が無いと効きません'
        + '（実行が無効なので実行の上限もありません）。');`,
        to: '    /* 変異: 効かないことを言わない */',
        gone: '--timeout は --exec が無いと効きません',
        pattern: '--timeout が効かない組み合わせを黙って捨てない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-already-timeout-diff',
        why: '「既に動いています」で上限の違いを見ない'
            + '（--timeout 3600 を打っても 600 秒のデーモンに案内して exit 0）',
        file: 'scripts/serveargs.mjs',
        from: `    if (req.execTimeout !== null && req.execTimeout !== run.execTimeout) {
        diffs.push({
            what: '--exec-timeout',
            want: \`\${req.execTimeout} 秒\`,
            have: run.execTimeout === null ? 'サーバ既定（600 秒）' : \`\${run.execTimeout} 秒\`,
        });
    }`,
        to: '    /* 変異: 上限の違いを見ない */',
        gone: "what: '--exec-timeout'",
        pattern: '「既に動いています」の差分は値まで見る',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-already-host-diff',
        why: '「既に動いています」で許可ホストの**値**を見ない'
            + '（box-a が動いているのに box-b を要求して exit 0 = スマホからは 403 のまま）',
        file: 'scripts/serveargs.mjs',
        from: `    for (const h of req.hosts) {
        if (!run.hosts.some(x => low(x) === low(h))) {
            diffs.push({
                what: '--allow-host',
                want: h,
                have: run.hosts.length ? run.hosts.join(', ') : 'ループバックのみ',
            });
        }
    }`,
        to: '    /* 変異: 許可ホストの値を見ない */',
        gone: 'low(x) === low(h)',
        pattern: '「既に動いています」の差分は値まで見る',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 純関数を全部テストしても「呼んでいない」は検出できないので、配線も外す
        name: 'serve-calls-config-diff',
        why: 'serve.mjs が差分の門を呼ばない（要求が黙って無効になる。純関数は緑のまま）',
        file: 'scripts/serve.mjs',
        // ⚠️ 解決済みの repos を渡すようになったので字面が変わった（--dry で検出）
        from: '    const diffs = configDiff(argv, already.cmd, { repos });',
        to: '    const diffs = [];   /* 変異: 差分を見ない */',
        gone: 'configDiff(argv, already.cmd, { repos })',
        pattern: '既に動いているデーモンとの差分で止まり',
        testFile: 'scripts/serveargs.test.mjs',
        platforms: ['win32'],   // running() は今のところ PowerShell 経由だけ
    },
    {
        name: 'serve-describe-exec-timeout',
        why: '動いている実行デーモンの上限を出さない'
            + '（「上限の話は1文字も出ない」= 打った --timeout が効いていないことに気付けない）',
        file: 'scripts/serveargs.mjs',
        from: `    if (caps.includes('--allow-exec')) {
        parts.push(execTimeout === null ? '上限 サーバ既定（600秒）' : \`上限 \${execTimeout}秒\`);
    }`,
        to: '    /* 変異: 上限を出さない */',
        gone: '上限 ${execTimeout}秒',
        pattern: '動いている実行デーモンの上限を必ず見せる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-stop-scope',
        why: '--stop がマシン上の全デーモンを対象にする'
            + '（repo B で 8 分走っている会話セッションが無言で消える。taskkill /T なので子孫も）',
        file: 'scripts/serveargs.mjs',
        // #54 で「分からない」を別枠にしたので、判定の行はこの形になった
        from: '        else if (serves) targets.push(r);\n        else others.push(r);',
        to: '        else targets.push(r);   /* 変異: repo で絞らない */',
        gone: 'else if (serves) targets.push(r);',
        pattern: '--stop の既定はカレントのリポジトリだけ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-stop-shows-repo',
        why: '--stop が止める相手の repo と capability を出さない'
            + '（他のリポジトリを道連れにしても気付けない。--status は出しているので非対称）',
        file: 'scripts/serve.mjs',
        from: `    const line = (r, note) => \`  PID \${r.pid}  port \${r.port ?? '?'}  \${describeCaps(r.cmd)}\`
        + \`\${note}  \${repoOf(r.cmd) ?? '(repo 不明)'}\`;`,
        to: "    const line = (r, note) => `  PID ${r.pid}  port ${r.port ?? '?'}${note}`;",
        gone: "(repo 不明)",
        pattern: '既に動いているデーモンとの差分で止まり',
        testFile: 'scripts/serveargs.test.mjs',
        platforms: ['win32'],
    },
    {
        name: 'serve-stop-unknown-not-ok',
        why: '--stop の数え直しで「調べられない」を「止まりました」と読む'
            + '（2回目の PowerShell が失敗すると何も言わず exit 0。#31 と同型）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!after?.supported) return { exit: 1, unknown: true, left: [] };',
        to: '    /* 変異: 調べられないのを成功にする */',
        gone: 'unknown: true',
        pattern: '--stop は「調べられない」を「止まりました」と読まない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-all-requires-stop',
        why: '--all を --stop 無しでも受け付ける'
            + '（「全部止めるつもり」で打った --all が**起動**になる）',
        file: 'scripts/serve.mjs',
        from: "if (has('--all') && !has('--stop')) {",
        to: 'if (false) {',
        gone: "has('--all') && !has('--stop')",
        pattern: '--all を --stop 無しで受け付けない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 レイアウト検査のために周期タイマーを止められるようにしたので、
        //    **実運用では止まっていない**ことを測る（止まると盤が古い状態を
        //    出し続け、「どれが待っているか」が分からなくなる）。
        name: 'probe-timers-scope',
        why: '検査用の timers=0 が実運用のページでも効く'
            + '（周期更新が止まり、監視盤が古い状態を出し続ける）',
        file: 'v0/app.html',
        from: 'const noTimers = window.__kjpProbe',
        to: 'const noTimers = true ||   /* 変異: 本番でも止める */ window.__kjpProbe',
        gone: 'const noTimers = window.__kjpProbe',
        script: 'v0/render-check.mjs',
    },
    {
        // #3 の予算。**`node --test` ではなく実ブラウザの検査に掛ける**
        name: 'render-raf-batch',
        why: 'rAF でまとめるのをやめる（1件ごとに scrollHeight を読んで総文字数に対して二次。'
            + '実測 12,000行で 53.8秒、その間 停止ボタンも自動更新も効かない）',
        file: 'v0/app.html',
        from: '    if (!flushing) { flushing = true; schedule(); }',
        to: '    flush();',
        gone: 'if (!flushing) { flushing = true; schedule(); }',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 7回目のレビュー: finish が先だと exit の後ろに出力が並び、live には届かない
        name: 'kill-then-finish-order',
        why: '殺す前に終端する（実際に死ぬまでの出力が live に届かず告知も無い。'
            + '出力が多いと exit 自身がリングから押し出されて終端が消える）',
        file: 'v0/server.mjs',
        // ⚠️ **finish を消すだけでは元のバグにならない**（子の 'exit' ハンドラが
        //    後から finish するので、結果は「殺してから終端」= 修正後と同じになる。
        //    最初これで書いて SURVIVED になった）。**順序を元に戻す**のが正しい変異。
        from: "                    s.killRequested = 'requested';",
        to: "                    s.killRequested = 'requested';\n"
            + "                    execRegistry.finish(s, { code: null, signal: 'SIGKILL',\n"
            + "                        note: '⚠ 停止を要求されました' });   /* 変異: 殺す前に終端する */",
        gone: "s.killRequested = 'requested';\n                    const r =",
        pattern: 'exit の後ろに並ばない',
    },
    {
        name: 'kill-confirm',
        why: 'killTree の成否を確かめずに「停止しました」と記録する'
            + '（殺せなくても signal:SIGKILL と書き、以後 sweep も候補にしないので回復経路が無い）',
        file: 'v0/server.mjs',
        from: '    const taskkillNote = taskkillCode ? `taskkill は exit ${taskkillCode}` : null;',
        to: '    return { killed: true, why: null };   /* 変異: 数え直しをしない */',
        gone: 'const taskkillNote = taskkillCode',
        // ⚠️ **以前は「測れない」と書いて defensive にしていた**（「落ちないプロセスを
        //    移植可能に作れない」）。それは**思い込みだった**: プロセスグループから
        //    逃げる孫（`detached: true`）を作れば、POSIX では `kill(-pgid)` が届かず
        //    確実に生き残るので、**主張と実態の食い違いとして測れる**。
        //    Windows は `taskkill /T` が ppid を辿って孫まで落とすので測れない。
        platforms: ['linux', 'darwin'],
        pattern: '「停止しました」が実態と一致する',
    },
    // -----------------------------------------------------------------
    // 🚨 9回目のレビュー / #49: 監視盤は購読せずに入力できるのに、
    //    切断後の猶予は購読/解除の時刻でしか進まなかった。
    //    判断（execsession）と配線（server）を**別々に**測る。
    // -----------------------------------------------------------------
    {
        name: 'input-extends-grace',
        why: '入力しても切断後の猶予を延ばさない'
            + '（スマホから返事を書いている最中のセッションが SIGKILL される）',
        file: 'v0/execsession.mjs',
        from: '        s.lastDetachedAt = this.now();\n        return true;',
        to: '        return true;   /* 変異: 猶予を延ばさない */',
        gone: 's.lastDetachedAt = this.now();\n        return true;',
        pattern: '入力が通ったら切断後の猶予はやり直しになる',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        // ⚠️ 判断が正しくても**呼んでいなければ**同じ事故が起きる。配線を測る。
        name: 'input-grace-wiring',
        why: '/input が noteInput を呼ばない（判断は正しいのに配線が無い）',
        file: 'v0/server.mjs',
        from: '                    execRegistry.noteInput(s);',
        to: '                    /* 変異: 猶予を延ばさない */',
        gone: 'execRegistry.noteInput(s);',
        pattern: '入力している間は猶予',
    },
    {
        // 🚨 **延ばす対象を広げすぎない。** 購読中は猶予の外なので、
        //    そこで起点を作ると解除後の猶予が狂う（実質2倍待つ）。
        name: 'input-grace-only-detached',
        why: '購読中のセッションでも猶予の起点を作る（解除後の猶予が狂う）',
        file: 'v0/execsession.mjs',
        from: '        if (s.subscribers.size) return false;',
        to: '        /* 変異: 購読中でも起点を作る */',
        gone: 'if (s.subscribers.size) return false;',
        pattern: '購読中の入力は猶予に触らない',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'sweep-skip-killing',
        why: '殺しに行っているセッションを sweep がもう一度候補にする（二重に殺しに行く）',
        file: 'v0/execsession.mjs',
        from: '                if (s.killRequested) continue;',
        to: '                /* 変異: 二重の kill を防がない */',
        gone: 'if (s.killRequested) continue',
        pattern: '上限時間を超えたら停止する',
        defensive: '現状は二重に殺しても結果は同じ（killTree は冪等で finish も1回だけ効く）。'
            + '殺せなかったときに killRequested を戻して再試行させる形の前提なので、前出しで残す',
    },
    {
        name: 'session-absolute-timeout',
        why: 'session レコードに絶対上限を入れない'
            + '（UI が「切断しても最後まで走ります」= 完走の約束しか言えなくなる。'
            + '実際は --exec-timeout で SIGKILL される）',
        file: 'v0/server.mjs',
        // ⚠️ **`/api/v0/exec/list` の `limits` にも同じ行ができた。**
        //    字面（インデント込み）だけでは substring として二重に一致するので、
        //    直前の行まで含めて一意にする（`--dry` が「2箇所」と教えてくれた）
        from: '        //    （スマホで会話を始めて席を離れると10分で殺され、文脈は取り戻せない）。\n'
            + '        timeoutMs: opts.execTimeoutMs,',
        to: '        /* 変異: 絶対上限を送らない */',
        gone: '文脈は取り戻せない）。\n        timeoutMs:',
        // ⚠️ assert を足したのは「明示的な kill」のテストの中（keepAlive の session を
        //    読んでいる場所）。**pattern は assert がある側のテスト名にする**
        pattern: '明示的な kill で止まり',
    },
    {
        // 🚨 7回目のレビュー: 日本語入力の確定 Enter で実行が発火していた
        name: 'ime-composing-exec',
        why: 'IME の変換確定 Enter で実行が発火する'
            + '（未確定の argv が splitArgv されて worktree でそのまま走る）',
        file: 'v0/app.html',
        from: "    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !run.disabled) start();",
        to: "    if (e.key === 'Enter' && !run.disabled) start();",
        gone: "!e.isComposing && e.keyCode !== 229 && !run.disabled",
        script: 'v0/render-check.mjs',
    },
    {
        // #4: ファイラの数字が信じられる形になっていること
        name: 'filer-what-diff',
        why: 'ファイラが「何の差分か」を言わない（`base...HEAD` のコミット済み差分と'
            + 'カードの「変更 N・未追跡 N」= 未コミットの数を、同じ見た目で並べる）',
        file: 'v0/app.html',
        from: `  tree.append(el('div', 'note',
    \`コミット済みの差分です（\${s.base ?? 'base'} と各 worktree の HEAD を比べたもの）。\`
    + ' カードの「変更 N・未追跡 N」は未コミットの数なので、一致しません。'));`,
        to: '  /* 変異: 何の差分かを言わない */',
        gone: '未コミットの数なので、一致しません',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'filer-uncommitted-count',
        why: 'コミット済み差分ゼロのときに未コミットの数を出さない'
            + '（「変更 1」なのに「(差分なし)」になり、どちらの数字も信じられなくなる #4）',
        file: 'v0/app.html',
        from: `      tree.append(el('div', 'f', uncommitted
        ? \`   (コミット済みの差分なし / 未コミット \${uncommitted} 件)\`
        : '   (差分なし)'));`,
        to: "      tree.append(el('div', 'f', '   (差分なし)'));",
        gone: 'コミット済みの差分なし / 未コミット',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-term-trim',
        why: '表示上限で古い要素を捨てるのをやめる（DOM が無限に伸びて固まる）',
        file: 'v0/app.html',
        from: '    if (termEl.childNodes.length > TERM_MAX_SPANS) {',
        to: '    if (false) {',
        gone: 'termEl.childNodes.length > TERM_MAX_SPANS',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-trim-notice',
        why: '捨てたことの告知を出さない（「全部見えている」と誤認させる）',
        file: 'v0/app.html',
        from: `        notice = el('span', 'w', \`⚠ 出力が多いので古い行を捨てています（直近 \${TERM_MAX_SPANS} 要素）
\`);
        termEl.prepend(notice);`,
        to: "        notice = el('span', 'w', '');\n        termEl.prepend(notice);",
        gone: '古い行を捨てています',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-trim-keeps-notice',
        why: '告知の次からではなく先頭から捨てる（次のトリムで告知自身が消える）',
        file: 'v0/app.html',
        from: '      for (let i = 0; i < drop; i++) notice.nextSibling?.remove();',
        to: '      for (let i = 0; i < drop; i++) termEl.firstChild?.remove();',
        gone: 'notice.nextSibling?.remove()',
        script: 'v0/render-check.mjs',
    },
    // ---- 全文ビューア -------------------------------------------------------
    {
        name: 'blob-view-line-limit',
        why: '表示上限を外す（巨大なファイルを丸ごと DOM に入れて固まる。'
            + '32000 行で実測 613ms、上限が無ければ行数に比例して伸び続ける）',
        file: 'v0/blobview.mjs',
        from: '    const truncated = totalLines > maxLines;',
        to: '    const truncated = false;',
        gone: 'totalLines > maxLines',
        pattern: '表示上限で切ったら',
        testFile: 'v0/blobview.test.mjs',
    },
    {
        name: 'blob-view-limit-notice',
        why: '切ったのに告知しない（「全部見えている」と誤認させる。'
            + 'コードを読んでいるときに末尾が無いことに気付けない）',
        file: 'v0/blobview.mjs',
        from: `        notices.push(\`⚠ 行が多いので先頭 \${maxLines} 行だけ表示しています\`
            + \`（全 \${totalLines} 行）。残り \${totalLines - maxLines} 行は表示していません。\`);`,
        to: '        /* 変異: 切ったことを告知しない */',
        gone: '行だけ表示しています',
        pattern: '表示上限で切ったら',
        testFile: 'v0/blobview.test.mjs',
    },
    {
        // 🚨 **行を消さずに到達不能にする変異**（#41 と同じ型）。
        //    `blobview.mjs` に告知は残っているのに、画面に出さない。
        //    字面を見る検査では**完全に見えない**ので、実ブラウザで
        //    「見える文字」を測っていることの確認になる。
        name: 'blob-view-notice-not-drawn',
        why: '告知を作っているのに描かない（planBlobView は正しいまま、'
            + '画面には出ないので「全部見えている」に戻る）',
        file: 'v0/app.html',
        from: "  for (const n of plan.notices) box.append(el('div', 'note warn', n));",
        to: "  for (const n of []) box.append(el('div', 'note warn', n));",
        gone: 'for (const n of plan.notices)',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'blob-render-per-line-layout',
        why: '1行ごとに DOM へ足してレイアウトを起こす（総文字数に対して二次。'
            + '同じ環境の実測で 1000行 3.4秒 / 2000行 14.5秒 / 4000行 59.1秒）',
        file: 'v0/app.html',
        from: `  const frag = document.createDocumentFragment();
  for (let i = 0; i < plan.lines.length; i++) frag.append(blobRow(i + 1, plan.lines[i]));
  box.append(frag);
  holder.replaceChildren(box);`,
        to: `  holder.replaceChildren(box);
  for (let i = 0; i < plan.lines.length; i++) {
    box.append(blobRow(i + 1, plan.lines[i]));
    void holder.scrollHeight;   /* 変異: 毎行 強制同期レイアウト */
  }`,
        gone: 'box.append(frag)',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'blob-view-mode-not-kept',
        why: '選んだモードを覚えない（15 秒ごとの自動更新でペインを作り直すので、'
            + '**読んでいる途中で全文が差分に戻る**）',
        file: 'v0/app.html',
        from: "    if (obj.mode !== 'blob') obj.mode = 'diff';",
        to: "    obj.mode = 'diff';",
        gone: "if (obj.mode !== 'blob')",
        script: 'v0/render-check.mjs',
    },
    {
        name: 'blob-server-max-bytes',
        why: '巨大な blob を全部メモリに読む（512KB の上限を外すと、'
            + '1リクエストでリポジトリ内の最大ファイル分のメモリを取られる）',
        file: 'v0/git.mjs',
        from: "        buf = await git(['cat-file', 'blob', oid],\n"
            + '            { cwd, raw: true, maxBytes: MAX_BLOB_BYTES + 1024 });',
        to: "        buf = await git(['cat-file', 'blob', oid], { cwd, raw: true });",
        // ⚠️ `maxBytes: MAX_BLOB_BYTES + 1024` は fileDiff にもある。
        //    **インデントまで含めて一意にする**（同じ式が他所にできると SKIP に落ち、
        //    守りが検証されないまま静かに続く）
        gone: "'blob', oid],\n            { cwd, raw: true, maxBytes:",
        pattern: 'サーバの上限を超えるファイルは中身を読まずに',
    },
    {
        name: 'blob-path-validation',
        why: 'blob の path 検証を外す（多重防御の手前側。git 側の失敗に頼ると'
            + '「拒否した」と「たまたま見つからなかった」の区別が付かなくなる）',
        file: 'v0/git.mjs',
        from: "    if (!isSafeRepoPath(path)) throw new GitError(['blob'], 2, `path が不正です: ${path}`);",
        to: '    /* 変異: path の検証を外す */',
        // ⚠️ `isSafeRepoPath(path)` は fileDiff にもある。blob 側だけを一意に指す
        gone: "isSafeRepoPath(path)) throw new GitError(['blob']",
        pattern: 'リポジトリ外へ抜けようとする path を拒否する',
    },
    {
        name: 'blob-ref-validation',
        why: 'blob の ref 検証を外す（`main~1` や `@{1}` が通り、'
            + '捨てたコミットの中身まで読める）',
        file: 'v0/git.mjs',
        from: "    if (!isSafeRef(ref)) throw new GitError(['blob'], 2, `ref が不正です: ${ref}`);",
        to: '    /* 変異: ref の検証を外す */',
        gone: 'isSafeRef(ref)) throw new GitError([\'blob\']',
        pattern: 'blob: ref にオプションやリビジョン式を渡せない',
    },
    {
        name: 'blob-tooLarge-binary-unknown',
        why: '読まなかったのに binary: false と断定する'
            + '（「調べられない」と「テキストである」を混同する。UI が'
            + '「バイナリではありません」と嘘をつくことになる）',
        file: 'v0/git.mjs',
        from: '            path, ref, oid, size, tooLarge: true, binary: null, text: null,',
        to: '            path, ref, oid, size, tooLarge: true, binary: false, text: null,',
        gone: 'tooLarge: true, binary: null',
        pattern: 'サーバの上限を超えるファイルは中身を読まずに',
    },
    {
        name: 'transcript-type-allowlist',
        why: '走査するレコード種別の許可リストを外すと、'
            + 'file-history-snapshot / attachment / last-prompt から自由文が漏れる',
        file: 'v0/transcript.mjs',
        from: '        if (!SCAN_TYPES.has(r.type)) continue;',
        to: '        /* 変異: 種別の許可リストを外す */',
        gone: 'SCAN_TYPES.has(r.type)',
        pattern: '知らないレコード種別は',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-t5',
        why: 'ツール結果と thinking を出す（読んだファイルの中身とコマンド出力が漏れる）',
        // ⚠️ 現在の実装では冗長。ブロックの抽出も許可リストで、
        //    `text` と `tool_use` 以外は素通りするので、この行を外しても漏れない。
        //    それでも残す理由: **意図を明示する行**であり、将来 `text` の扱いを
        //    一般化したときに最初に効く砦になる。冗長であることを記録しておく。
        defensive: 'ブロックの抽出も許可リスト（text / tool_use のみ）なので現状は二重。意図の明示として残す',
        file: 'v0/transcript.mjs',
        from: "            if (b.type === 'tool_result' || b.type === 'thinking') continue;",
        to: '            /* 変異: T5 の除外をやめる */',
        gone: "b.type === 'tool_result'",
        pattern: 'ツール結果と thinking は出さない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'serve-shared-modules',
        why: 'UI が import する共有モジュールを配信しない（import が1本 404 になると'
            + 'モジュール全体が実行されず**ページが真っ白**になる）',
        file: 'v0/server.mjs',
        // ⚠️ 並列で足した5つのモジュール（panelayout / pathlabel / mergeresult /
        //    linediff / blobview）が同じ条件に来たので、行をまたぐ形になった。
        //    **改行込みで一意に指定する**
        from: "            || url.pathname === '/chatfilter.mjs' || url.pathname === '/panelayout.mjs'\n"
            + "            || url.pathname === '/pathlabel.mjs' || url.pathname === '/mergeresult.mjs'\n"
            + "            || url.pathname === '/linediff.mjs' || url.pathname === '/blobview.mjs'\n"
            + "            || url.pathname === '/dirlabel.mjs'\n"
            + "            || url.pathname === '/mergeplan.mjs'\n"
            + "            || url.pathname === '/inputnote.mjs'\n"
            + "            || url.pathname === '/panegrid.mjs') {",
        to: '            || false) {',
        gone: "url.pathname === '/chatfilter.mjs'",
        pattern: 'import しているモジュールが全部配信される',
    },
    {
        name: 'chat-argv-detect',
        why: '会話モードを argv から見分けない（再接続で生のテキストを stdin に書き、'
            + 'claude が exit 1 で死んで会話の文脈が丸ごと消える。6回目のレビュー）',
        file: 'v0/argv.mjs',
        from: "        if (argv[i] === '--input-format' && argv[i + 1] === 'stream-json') return true;",
        to: '        /* 変異: 会話モードを見分けない */',
        gone: "argv[i] === '--input-format'",
        pattern: 'isChatArgv',
        testFile: 'v0/argv.test.mjs',
    },
    {
        name: 'chat-array-guard',
        why: 'content が配列でない行で feed が投げる'
            + '（購読ループが抜けて「停止」表示になるのにセッションは走り続ける）',
        file: 'v0/chatfilter.mjs',
        // ⚠️ 解釈を `chatRecordLines`（純関数）に出したのでインデントが変わった
        from: '        const blocks = Array.isArray(r.message?.content) ? r.message.content : null;',
        to: '        const blocks = r.message?.content ?? null;',
        // ⚠️ `chatInputText` にも同じ式ができたので**インデントまで含めて一意にする**
        //    （素の式だと書き換え後も残って STALE になる。記録済みの罠）
        gone: '        const blocks = Array.isArray(r.message?.content)',
        pattern: '壊れた行でも feed が投げない',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'chat-flush-tail',
        why: '改行で終わらない最後の行を捨てる（kill / クラッシュ / 途中で切れた場合の'
            + '**最後の応答が丸ごと消える** #44）',
        file: 'v0/chatfilter.mjs',
        // ⚠️ 出口を `emit` 経由にした（告知のまとめを必ず吐くため）ので字面を追従
        from: "        if (rest.trim()) emit({ cls: '', text: rest });",
        to: '        /* 変異: 残りを捨てる */',
        gone: 'if (rest.trim()) emit',
        pattern: '改行で終わらない最後の行を flush で出す',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'chat-unknown-type',
        why: '知らない type を黙って捨てる（control_response = 入力の許可拒否や'
            + '将来増える type が消え、「形式が変わったら黙って消える」状態に戻る #44）',
        file: 'v0/chatfilter.mjs',
        // ⚠️ 告知に kind:'skip' を付けた（まとめる対象を字面でなく構造で選ぶため）
        from: "    return [{ cls: 'd', kind: 'skip', text: `  （${kind} は表示していません）` }];",
        to: '    return [];   /* 変異: 知らない type を捨てる */',
        // ⚠️ 合計を組み立てる側にも同じ語が出たので、**式ごと**一意にする
        gone: '（${kind} は表示していません）',
        pattern: '知らない type を黙って捨てず',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        // 🚨 7回目のレビュー: 下限が exec だけだったので `--token abc` が通った
        name: 'token-min-length',
        why: '読み取り/書き込みトークンに長さの下限を掛けない'
            + '（--allow-host で唯一の壁になるのに、3文字なら総当たりで29回目に通った）',
        file: 'v0/server.mjs',
        from: 'if (opts.token !== null && opts.token.length < 24) {',
        to: 'if (false) {',
        gone: 'opts.token !== null && opts.token.length < 24',
        pattern: '短いトークンでは起動しない',
    },
    {
        name: 'auth-fail-audit',
        why: '認証失敗を記録しない（当て放題かつ痕跡ゼロで総当たりできる）',
        file: 'v0/server.mjs',
        from: '            else await noteAuthFail(req, url);',
        to: '            /* 変異: 失敗を記録も遅延もしない */',
        gone: 'await noteAuthFail(req, url)',
        pattern: '認証失敗は記録され',
    },
    {
        name: 'auth-fail-delay',
        why: '連続失敗に遅延を掛けない（総当たりが 1500 req/s で通る。実測）',
        file: 'v0/failtracker.mjs',
        // 遅延の実装は module に移った（読み取りの壁と実行の壁で共有する）
        from: "    if (!Number.isFinite(count) || count <= free) return 0;\n"
            + '    return Math.min(maxMs, 2 ** (count - free) * baseMs);',
        to: '    return 0;   /* 変異: 遅延を掛けない */',
        gone: '2 ** (count - free) * baseMs',
        pattern: '認証失敗は記録され',
    },
    {
        // 🚨 8回目のレビュー: 遅延は「1本ずつを遅くする」だけで並列を縛らない。
        //    実測で並列 1200 本なら 485 回/秒（遅延が有る状態で）。
        name: 'preauth-inflight-gate',
        why: '認証前の同時本数を縛らない（並列度がそのまま当てる速さになる。実測 485 回/秒）',
        file: 'v0/server.mjs',
        from: '        if (!trusted && !authGate.acquire(peer)) {',
        to: '        if (false) {   /* 変異: 並列を縛らない */',
        gone: '!authGate.acquire(peer)',
        pattern: '401 は並列でも縛られる',
    },
    {
        // ⚠️ 縛る側だけでなく「締め出さない側」も測る。
        name: 'preauth-known-good-bypass',
        why: '一度通った資格情報も混雑の門に掛ける'
            + '（トンネル越しでは peer が全部 127.0.0.1 なので、'
            + '総当たりの間 正規の利用者が 429 で締め出される。実測 15 本中 0 本）',
        file: 'v0/server.mjs',
        from: '        const trusted = knownGoodSecret(vals);',
        to: '        const trusted = false;   /* 変異: 一度通った値も門に掛ける */',
        gone: 'const trusted = knownGoodSecret(vals)',
        pattern: '総当たりが続いている間も正しい鍵は通り',
    },
    {
        name: 'auth-fail-aggregate',
        why: '401 を1本1行で追記する'
            + '（認証前の要求で .git の中のファイルを無制限に伸ばせる。実測 400 本で 61 KB）',
        file: 'v0/failtracker.mjs',
        from: '            if (rec.logged < logFirst) {',
        to: '            if (true) {   /* 変異: 常に個別行を書く */',
        gone: 'rec.logged < logFirst',
        pattern: '認証失敗は記録され',
    },
    {
        name: 'auth-fail-summary-rate',
        why: '集約行を件数ごとに出す（429 は毎秒1万本以上撃てるので、'
            + '「50件ごとに1行」でも 7 秒で 503 KB 伸びた。実測）',
        file: 'v0/failtracker.mjs',
        from: '        return rec.reported === 0 || t - rec.reportedAt >= summaryMs;',
        to: '        return true;   /* 変異: 毎回集約行を出す */',
        gone: 't - rec.reportedAt >= summaryMs',
        pattern: '総当たりが続いている間も正しい鍵は通り',
    },
    // ---------------------------------------------------------------------
    // 🚨 9回目のレビュー / #48: 実行・書き込みトークンの壁には3点セットが無かった。
    //    読み取り側（401）と**同じ数の変異を置く**（片方だけ測る状態を作らない）。
    // ---------------------------------------------------------------------
    {
        name: 'mutation-fail-record',
        why: '実行・書き込みトークンの失敗を記録も遅延もしない'
            + '（読み取り鍵を持つ相手が痕跡ゼロで総当たりできる。実測 2,505 回/秒・監査 0 B）',
        file: 'v0/server.mjs',
        from: '        else await mutationFails.note(peer, { ...originHint(req), path: pathOf(req) });',
        to: '        /* 変異: 実行の失敗を記録も遅延もしない */',
        gone: 'await mutationFails.note(peer',
        pattern: '実行トークンの総当たり',
    },
    {
        name: 'mutation-inflight-gate',
        why: '実行トークンの比較の同時本数を縛らない（並列度がそのまま当てる速さになる）',
        // 🚨 **順序（門が比較の手前にあること）もこれで測れている。**
        //    門を比較の後ろに置くと 403 が門より先に返るので、門は誰も止めない =
        //    **「門が無い」と観測上まったく同じ**になる。だから順序専用の変異は置かない
        //    （置いてみたが `DEFENSIVE` にしかならず、測れない守りを飾るだけだった）。
        file: 'v0/server.mjs',
        from: '    if (!trusted && !mutationGate.acquire(peer)) {',
        to: '    if (false) {   /* 変異: 並列を縛らない */',
        gone: '!mutationGate.acquire(peer)',
        pattern: '実行トークンの総当たり',
    },
    {
        name: 'mutation-known-good-bypass',
        why: '1度通った実行トークンも混雑の門に掛ける'
            + '（総当たりの間、正規の端末が実行できなくなる = 暴走を止めに行けない）',
        file: 'v0/server.mjs',
        from: '    const trusted = goodTokens.has(vals);',
        to: '    const trusted = false;   /* 変異: 一度通った値も門に掛ける */',
        gone: 'const trusted = goodTokens.has(vals)',
        // ⚠️ **攻撃が終わった後**に試す検査では測れない（門が空いているので通る）。
        //    持続攻撃の最中を測る検査に当てる（最初はこれを間違えて SURVIVED した）。
        pattern: '総当たり中でも',
    },
    {
        // 🚨 **読み取り側の控えを使い回すと直した意味が消える。**
        //    `goodSecrets` は読み取り用の派生秘密でも真になるので、
        //    その鍵を持つ相手が混雑の門を素通りして総当たりを続けられる。
        name: 'mutation-reuses-read-goodset',
        why: '実行の門で読み取り側の控えを使う'
            + '（案内 URL に載る読み取り鍵を持つ相手が門を素通りする）',
        file: 'v0/server.mjs',
        from: '    const trusted = goodTokens.has(vals);',
        to: '    const trusted = goodSecrets.has(vals);   /* 変異: 読み取りの控えを使う */',
        gone: 'const trusted = goodTokens.has(vals)',
        // ⚠️ **実測: この変異は SURVIVED する。攻略できないから。**
        //    門に渡す値は `x-kjp-token` ヘッダの1本だけで、**推測値そのもの**。
        //    読み取り鍵をヘッダに入れれば門は素通りできるが、その回は推測を
        //    載せられない（比較されるのも同じヘッダ）。つまり「門を抜けつつ当てる」
        //    が同時に成立しない。控えを分けているのは、将来 Cookie 由来の値を
        //    渡す形に変えたときに読み取り鍵が門を抜けるのを防ぐ**第二の砦**。
        defensive: '門に渡すのはヘッダ1本（= 推測値そのもの）なので、'
            + '読み取り鍵で門を抜けても同じ回に推測を載せられない = 到達不能。'
            + 'Cookie 由来の値を渡す形に変えた瞬間に効く第二の砦として残す',
        pattern: '実行トークンの総当たり',
    },
    // -----------------------------------------------------------------
    // 🚨 9回目のレビュー / #52: verify の要約が skipped を出していなかった。
    //    「SKIP を緑と読まない」と書いておきながら、要約自身がそれを破っていた。
    //    要約は verify.mjs の中にあってテストも変異も掛かっていなかったので、
    //    純関数として `scripts/testsummary.mjs` に出した。
    // -----------------------------------------------------------------
    {
        // 🚨 9回目のレビュー / #56: 検査が本物の ~/.kjp-edit/ に書いていた
        //    （実測: last.json が検査の一時リポジトリを指していた）。
        //    同じ場所に実行トークンがあるので、書ける経路自体が危ない。
        name: 'test-home-isolation',
        why: '検査の子プロセスが本物の HOME を継承する'
            + '（~/.kjp-edit/ の last.json や鍵を検査が書き換えられる）',
        // ⚠️ **この変異を走らせると、本物の `~/.kjp-edit/last.json` が
        //    一時リポジトリを指す値で上書きされる**（それが「守りが無いと何が
        //    起きるか」の証明そのものなので避けられない）。
        //    `last.json` は参考情報だけなので実害は無い（鍵は既存の値が読まれる
        //    だけで上書きされない）。気になるなら `serve.mjs` を1回起動し直せば
        //    正しい値に戻る。
        file: 'scripts/serveargs.test.mjs',
        from: '        ...(scratchHome ? { HOME: scratchHome, USERPROFILE: scratchHome } : {}),',
        to: '        /* 変異: 一時 HOME を渡さない */',
        gone: '...(scratchHome ? { HOME: scratchHome, USERPROFILE: scratchHome } : {})',
        // ⚠️ 見張りは after フックなので、pattern はどのテストでも良い
        //    （フックの失敗はファイル全体の失敗として出る）。
        // 🚨 **本当にサーバを起動する検査に当てる。** 早期の門で終わる検査に
        //    当てていたので、本物の HOME を継承しても**何も書かれず SURVIVED**した。
        //    `last.json` を書くのは「実起動」の経路だけ。
        pattern: '--timeout が実際にサーバに届く',
        testFile: 'scripts/serveargs.test.mjs',
    },
    // -----------------------------------------------------------------
    // 🚨 9回目のレビュー / #55（MINOR 2件）: 黙って増える2本目と、
    //    動いたポートでトンネルが切れることの告知。
    // -----------------------------------------------------------------
    // -----------------------------------------------------------------
    // 🚨 #57 段階1: グリッドのセルモデル。守りは4つ —
    //    「重ねない」「はみ出さない」「黙って捨てない」「閉じたものを開かない」。
    //    2枚が同じセルに描かれると**見えないペインが走り続ける**（観測ツールとして最悪）。
    // -----------------------------------------------------------------
    {
        name: 'grid-no-overlap-move',
        why: '重なる移動を通す（2枚が同じセルに描かれ、片方が見えないまま走り続ける）',
        file: 'v0/panegrid.mjs',
        from: "    const hit = g.cells.filter(c => c.id !== id && cellsOverlap(c, target));",
        to: "    const hit = [];   /* 変異: 重なりを見ない */",
        gone: "const hit = g.cells.filter(c => c.id !== id && cellsOverlap(c, target));",
        pattern: '大きさの違う相手・複数に重なる移動は断る',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-no-overlap-resize',
        why: '広げる先に他が居ても広げる（同じセルに2枚）',
        file: 'v0/panegrid.mjs',
        from: "    if (!cellFree(g, want, id)) {",
        to: "    if (false) {   /* 変異: 空きを見ない */",
        gone: "if (!cellFree(g, want, id)) {",
        // ⚠️ pattern は**テスト名に含まれる文字列**にする（外れると0件走って
        //    SURVIVED と誤報する。CLAUDE.md の既知の罠）
        pattern: 'その先に他が居るなら断る',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-bounds',
        why: 'グリッドの外へのはみ出しを通す（描かれない位置にペインを置く）',
        file: 'v0/panegrid.mjs',
        from: "    return c.col + c.cw - 1 <= cols && c.row + c.ch - 1 <= rows;",
        to: "    return true;   /* 変異: はみ出しを見ない */",
        gone: "return c.col + c.cw - 1 <= cols && c.row + c.ch - 1 <= rows;",
        pattern: 'はみ出しを通さない',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-overflow-announced',
        why: '入り切らないペインを黙って捨てる（「1本も走っていない」と読める）',
        file: 'v0/panegrid.mjs',
        from: "        if (!at) { overflow.push(id); continue; }",
        to: "        if (!at) { continue; }   /* 変異: 溢れを黙って捨てる */",
        gone: "if (!at) { overflow.push(id); continue; }",
        pattern: '入り切らない分を overflow で返す',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-closed-stays-closed',
        why: '閉じたペインを自動配置で開き直す（15秒ごとに戻ってきて閉じられない）',
        file: 'v0/panegrid.mjs',
        from: "        if (placed.has(id) || g.closed.includes(id)) continue;",
        to: "        if (placed.has(id)) continue;   /* 変異: 閉じたことを無視する */",
        gone: "if (placed.has(id) || g.closed.includes(id)) continue;",
        pattern: '閉じたペインは自動配置で戻ってこない',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-keeps-placed',
        why: '自動配置が既にある配置を上書きする（利用者が置いた位置を巻き戻す）',
        file: 'v0/panegrid.mjs',
        from: "    const placed = new Set(g.cells.map(c => c.id));",
        to: "    const placed = new Set();   /* 変異: 既存の配置を見ない */",
        gone: "const placed = new Set(g.cells.map(c => c.id));",
        pattern: '既にある配置を動かさない',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-shrink-reports',
        why: 'グリッドを縮めたときにはみ出す分を黙って消す（どれが消えたか分からない）',
        file: 'v0/panegrid.mjs',
        from: "        else dropped.push(cell.id);",
        to: "        else { /* 変異: 落ちたことを言わない */ }",
        gone: "else dropped.push(cell.id);",
        pattern: 'はみ出す分を dropped で返す',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-parse-dedup',
        why: '保存値の重複した id を両方残す（どちらが本物かが配列順で決まる）',
        file: 'v0/panegrid.mjs',
        from: "        if (seen.has(cell.id)) continue;",
        to: "        /* 変異: 重複を許す */",
        gone: "if (seen.has(cell.id)) continue;",
        pattern: '重複した id と重なるセルは後から来た方を落とす',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-parse-no-throw',
        why: '壊れた保存値で例外を投げる（モジュールの評価が止まりページが真っ白になる）',
        file: 'v0/panegrid.mjs',
        from: "    try { raw = JSON.parse(text); } catch { return out; }",
        to: "    raw = JSON.parse(text);   /* 変異: 壊れた値で投げる */",
        gone: "try { raw = JSON.parse(text); } catch { return out; }",
        pattern: '壊れた保存値は「配置なし」にする',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        name: 'grid-migrate-v1',
        why: 'v1 の配置を移行しない（利用者が移した位置が1回全部消える）',
        file: 'v0/panegrid.mjs',
        from: "    put(layout?.left, 1, 1, g.rows);",
        to: "    /* 変異: 移行しない */",
        gone: "put(layout?.left, 1, 1, g.rows);",
        pattern: 'v1 の配置をグリッドへ移す',
        testFile: 'v0/panegrid.test.mjs',
    },
    {
        // 🚨 #46: 置き直しが `append` で全ペインを動かしていたので、
        //    過去の出力を読んでいる最中にスクロールが先頭へ飛んだ（実測 21258 → 0）。
        //    さらに 0 に戻った直後の scroll で追従が切れ、以降を追いかけなくなる。
        name: 'layout-keeps-scroll',
        why: '置き直しで既に正しい位置のペインも動かす'
            + '（scrollTop が 0 に戻り、長い出力が読めず追従も切れる）',
        file: 'v0/app.html',
        from: '  if (sameOrder) {',
        to: '  if (false) {   /* 変異: 毎回置き直す */',
        gone: '  if (sameOrder) {',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'other-daemons-note',
        why: '他に動いているデーモンを告げない'
            + '（--status を打つまで何本動いているか分からない。実行枠と監査が別々に増える）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!others.length) return null;',
        to: '    return null;   /* 変異: 何も言わない */',
        gone: '    if (!others.length) return null;',
        pattern: '他に動いているデーモンを告げる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // ⚠️ 「調べられない」を「0 本」と言わない側も測る（#31 と同型）
        name: 'other-daemons-unknown',
        why: '調べられないときに「他に 0 本」と断言する（止め残しと同じ型の嘘）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!probe?.supported) return null;',
        to: '    /* 変異: 調べられなくても数える */',
        gone: '    if (!probe?.supported) return null;',
        pattern: '他に動いているデーモンを告げる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'port-shift-tunnel-note',
        why: 'ポートが動いてもトンネルの向き先を告げない'
            + '（母艦では正常・スマホからだけ繋がらない = 手元では気付けない）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!Array.isArray(hosts) || !hosts.length) return [];',
        to: '    return [];   /* 変異: 何も言わない */',
        gone: '    if (!Array.isArray(hosts) || !hosts.length) return [];',
        pattern: 'ポートが動いたら向き先を告げる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 9回目のレビュー / #54: repo が読めなかった相手を
        //    「別のリポジトリなので止めません」と**断言**していた。
        //    分からないだけなので、止め残しに気付けない。
        name: 'stop-unknown-repo-claim',
        why: 'repo を判定できない相手を「別のリポジトリ」と断言する'
            + '（止め残しに気付けない。「分からない」と「無い」を混ぜる型）',
        file: 'scripts/serveargs.mjs',
        from: '        if (serves === null) unknown.push(r);',
        to: '        if (false) unknown.push(r);   /* 変異: 分からないものを別枠にしない */',
        gone: 'if (serves === null) unknown.push(r);',
        pattern: '「別のリポジトリ」と断言しない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // ⚠️ 判断が正しくても**出力に出ていなければ**同じ事故が起きる（配線）。
        name: 'stop-unknown-repo-wiring',
        why: '「リポジトリが分からない」相手を出力に出さない（黙って止め残す）',
        file: 'scripts/serve.mjs',
        from: "            console.log(line(r, '  ← リポジトリが分からないので止めません'));",
        to: '            /* 変異: 出さない */',
        gone: "'  ← リポジトリが分からないので止めません'",
        pattern: '「分からない」と出す',
        testFile: 'scripts/serveargs.test.mjs',
        // ⚠️ Windows でしか動いているものを調べられない（running() が supported:false）
        platforms: ['win32'],
    },
    {
        name: 'summary-counts-skipped',
        why: '飛ばした検査の件数を数えない'
            + '（プラットフォームで測っていない検査が、緑と区別できなくなる）',
        file: 'scripts/testsummary.mjs',
        from: "    for (const key of ['pass', 'fail', 'skipped', 'todo']) {",
        to: "    for (const key of ['pass', 'fail']) {   /* 変異: skip を数えない */",
        gone: "'pass', 'fail', 'skipped', 'todo'",
        pattern: 'skipped を数える',
        testFile: 'scripts/testsummary.test.mjs',
    },
    {
        name: 'summary-lists-skipped',
        why: 'どの検査が飛ばされたかを返さない'
            + '（件数だけでは「何が未検証か」が分からない）',
        file: 'scripts/testsummary.mjs',
        from: '    const skippedNames = lines',
        to: '    const skippedNames = [];   /* 変異: 一覧を返さない */\n    const unusedLines = lines',
        gone: '    const skippedNames = lines',
        pattern: 'どれが飛ばされたかも返す',
        testFile: 'scripts/testsummary.test.mjs',
    },
    {
        // ⚠️ 名前に理由（`# …`）が混ざると一覧が読めなくなる
        name: 'summary-skipped-name-only',
        why: '飛ばした検査の名前に理由を混ぜる（一覧が読めなくなる）',
        file: 'scripts/testsummary.mjs',
        from: "        .map(l => /^\\s*﹣\\s+(.+?)\\s+\\(/.exec(l))",
        to: "        .map(l => /^\\s*﹣\\s+(.+)/.exec(l))   /* 変異: 括弧まで取らない */",
        gone: "(.+?)\\s+\\(/.exec(l)",
        pattern: 'どれが飛ばされたかも返す',
        testFile: 'scripts/testsummary.test.mjs',
    },
    {
        name: 'audit-rotate',
        why: '監査ログに大きさの上限が無い（長く動かすだけで伸び、'
            + '認証前の要求からも伸ばせる）',
        file: 'v0/server.mjs',
        from: '        if (auditBytes + len > opts.auditMaxBytes) {',
        to: '        if (false) {   /* 変異: 回転しない */',
        gone: 'auditBytes + len > opts.auditMaxBytes',
        pattern: '監査ログは上限で回転',
    },
    {
        name: 'audit-rotate-announced',
        why: '回転したことを記録に残さない（記録を捨てたのに黙っている）',
        file: 'v0/server.mjs',
        from: "            await appendFile(path, notice, 'utf8');",
        to: '            /* 変異: 回転を記録に残さない */',
        gone: "appendFile(path, notice, 'utf8')",
        pattern: '監査ログは上限で回転',
    },
    {
        name: 'serveargs-audit-any-cap',
        why: '監査ログの置き場所を --exec のときだけ渡す'
            + '（読み取り専用 + --allow-host の常用構成では 401 の記録を .git の外に'
            + '出せず、トンネルの向こうから容量を食える）',
        file: 'scripts/serveargs.mjs',
        from: "    if (auditLog) args.push('--audit-log', auditLog);\n    if (wantExec) {",
        to: '    if (wantExec) {',
        gone: "if (auditLog) args.push('--audit-log', auditLog)",
        pattern: '監査ログの置き場所はどの capability でも渡す',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 7回目のレビュー: read 権限のコマンド行に実行トークンが載っていた
        name: 'transcript-mask-secrets',
        why: 'コマンド行の秘密をマスクしない（read 権限で実行トークンが読めて '
            + 'read → RCE に昇格する。README が案内していた起動手順がまさにその形）',
        file: 'v0/transcript.mjs',
        from: '                    const masked = maskSecrets(input.command, secrets);',
        to: '                    const masked = { text: input.command, masked: false };',
        gone: 'maskSecrets(input.command, secrets)',
        pattern: 'コマンド行から自分の資格情報を落とし',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-mask-announce',
        why: 'マスクしたことを告知しない（黙って消すと「そう打っていない」と誤読される）',
        file: 'v0/transcript.mjs',
        from: '                    if (masked.masked) entry.commandMasked = true;',
        to: '                    /* 変異: 落としたことを言わない */',
        gone: 'entry.commandMasked = true',
        pattern: 'コマンド行から自分の資格情報を落とし',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 8回目のレビュー: 形ベースの検出が空白1文字しか見ていなかった。
        //    タブは素通り、行継続は**継続の `\` をマスクして masked:true を立てる** =
        //    「秘密を落としました」と表示しながら秘密を並べる（最も重い「嘘」）
        name: 'transcript-mask-whitespace',
        why: '秘密の区切りを空白1文字だけに戻す（タブで素通りし、行継続では'
            + '継続文字だけをマスクして「落とした」と嘘をつく）',
        file: 'v0/transcript.mjs',
        from: 'const SECRET_WS = "\\\\s";',
        to: 'const SECRET_WS = "[ ]";   /* 変異: 空白1文字しか見ない */',
        gone: 'const SECRET_WS = "\\\\s"',
        pattern: '秘密の区切りはタブ・改行・行継続',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-mask-continuation',
        why: '行継続（`\\` + 改行）を畳まない（継続文字を「値」としてマスクし、'
            + '秘密は次の行に残る。clip が畳むので綺麗な1行として payload に出る）',
        file: 'v0/transcript.mjs',
        from: '    let out = text.replace(CONTINUATION_RE, "");',
        to: '    let out = text;   /* 変異: 行継続を畳まない */',
        gone: 'text.replace(CONTINUATION_RE',
        pattern: '秘密の区切りはタブ・改行・行継続',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-mask-quoted-value',
        why: 'クォートで囲んだ値を1つとして食わない（`--password "pass phrase X"` の'
            + ' `"pass` だけ落として残りを残す = 部分マスク。落としたと言いながら秘密が残る）',
        file: 'v0/transcript.mjs',
        from: 'const SECRET_VALUE = "(?:\\"[^\\"]*\\"?|\'[^\']*\'?|[^" + SECRET_WS + "\'\\"]+)";',
        to: 'const SECRET_VALUE = "[^" + SECRET_WS + "]+";   /* 変異: クォートを見ない */',
        gone: 'SECRET_VALUE = "(?:',
        pattern: '秘密の区切りはタブ・改行・行継続',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-mask-auth-scheme',
        why: '`authorization: Bearer <値>` の「Bearer」を値と見なして落とし、'
            + 'トークンを残す（告知だけ立つので「落とした」と嘘をつく）',
        file: 'v0/transcript.mjs',
        from: 'const AUTH_SCHEME = "(?:(?:bearer|basic|token)" + SECRET_WS + "+)?";',
        to: 'const AUTH_SCHEME = "";   /* 変異: スキーム語を値と見なす */',
        gone: 'AUTH_SCHEME = "(?:',
        pattern: '秘密の区切りはタブ・改行・行継続',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 8回目のレビュー: 発話（text[]）は同じ read 権限で同じ payload に出るのに
        //    マスクがコマンド行にしか掛かっていなかった。守りは入ったが検査が無かった
        name: 'transcript-text-mask-secrets',
        why: '発話の秘密をマスクしない（「起動は … --token X です」の形で'
            + '実行トークンが read 権限で読める = read → RCE に昇格する）',
        file: 'v0/transcript.mjs',
        from: '                    const masked = maskSecrets(b.text, secrets);',
        to: '                    const masked = { text: b.text, masked: false };',
        gone: 'maskSecrets(b.text, secrets)',
        pattern: '発話からも資格情報を落とし',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-text-mask-announce',
        why: '発話でマスクしたことを告知しない（コマンド行だけ告知して発話は'
            + '黙って消す = 同じ約束を片方で破る）',
        file: 'v0/transcript.mjs',
        from: '                        if (masked.masked) item.masked = true;',
        to: '                        /* 変異: 落としたことを言わない */',
        gone: 'item.masked = true',
        pattern: '発話からも資格情報を落とし',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 8回目のレビュー: 「(リポジトリ外)」を3つの別の理由で断言していた
        name: 'transcript-path-root-is-inside',
        why: 'worktree ルート自身を「外」と言う（`Grep`/`Glob` の `path` に'
            + 'ルートを渡す形で普通に起き、実データに 5 件あった）',
        file: 'v0/transcript.mjs',
        from: "    if (rel === '') return { rel: null, why: 'root' };",
        to: "    if (rel === '') return { rel: null, why: 'outside' };",
        gone: "why: 'root' }",
        pattern: 'パスが出せない理由を区別して表示する',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-path-unsafe-is-inside',
        why: '中にあるが表示できない形（先頭が `-` や `:`）を「外」と言う'
            + '（リポジトリ内のファイルに「外を触った」と断言する）',
        file: 'v0/transcript.mjs',
        from: "    if (!isSafeRepoPath(rel)) return { rel: null, why: 'unsafe' };",
        to: "    if (!isSafeRepoPath(rel)) return { rel: null, why: 'outside' };",
        gone: "why: 'unsafe' }",
        pattern: 'パスが出せない理由を区別して表示する',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'pathlabel-outside-only',
        why: 'パスが無い理由を全部「(リポジトリ外)」にする'
            + '（app.html に書いていた元の形。安全に関わる誤った断定）',
        file: 'v0/pathlabel.mjs',
        from: "    if (r.outside === true) return '(リポジトリ外)';",
        to: "    return '(リポジトリ外)';   /* 変異: 理由を区別しない */",
        gone: 'if (r.outside === true)',
        pattern: 'パスが出せない理由を区別して表示する',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'server-passes-secrets',
        why: 'サーバが自分の資格情報を渡さない（マスクの仕組みがあっても効かない）',
        file: 'v0/server.mjs',
        // ⚠️ 集約先（`secretsForMasking()`）に移したので、そちらを空にする。
        //    呼び出し側の字面を見ていた古い変異は `--dry` で STALE として出た
        from: '    return [opts.token, cookieSecret()].filter(Boolean);',
        to: '    return [];   /* 変異: 自分の秘密を渡さない */',
        gone: 'return [opts.token, cookieSecret()]',
        pattern: 'コマンド行に載った実行トークンを read 権限で配らない',
    },
    {
        // 🚨 7回目のレビュー: 相対パスをデーモンの cwd で解決していた
        name: 'transcript-relative-cwd',
        why: '相対パスをデーモンの cwd で解決する'
            + '（触っていないファイルを「触った」と表示し、worktree 内を「外」と表示する）',
        file: 'v0/transcript.mjs',
        from: `    let abs = raw;
    if (typeof raw === 'string' && raw && !isAbsolutePath(raw)) {
        if (typeof recordCwd === 'string' && recordCwd) abs = join(recordCwd, raw);
        else return { path: null, outside: false, clipped: false, unresolved: true };
    }`,
        to: '    const abs = raw;   /* 変異: 相対パスをそのまま渡す */',
        gone: 'isAbsolutePath(raw)',
        pattern: '相対パスはレコードの cwd で解決し',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-dir-not-dropped',
        why: '1ファイルの stat 失敗でプロジェクト丸ごとを捨てる'
            + '（稼働中でも「記録がありません」と断言する。#27/#36/#37 と同型）',
        file: 'v0/transcript.mjs',
        from: '            } catch { skippedFiles++; }   // そのファイルだけ飛ばす',
        to: '            } catch { break; }   /* 変異: そのディレクトリを丸ごと捨てる */',
        gone: 'catch { skippedFiles++; }',
        pattern: '1ファイルが読めなくてもプロジェクトを捨てない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 **この変異は以前 `defensive` で「junction が作れないので測れない」と
        //    書いていたが、それは事実と違った**（9回目のレビューが指摘）。
        //    `v0/paths.test.mjs` と `v0/transcript.test.mjs` は
        //    `symlink(..., 'junction')` で実際に作れており、手元でも作れる。
        //    つまり「未検証を defensive で誤魔化した」形だった（CLAUDE.md が禁じている）。
        //    守り自体も作り直した（段を混ぜない）ので、字面ごと差し替える。
        name: 'relative-inside-mix',
        why: '元表記と解決後のパスから段を混ぜる'
            + '（junction が段を跨ぐと、worktree の外のディレクトリ名が'
            + '「中のパス」として payload に載り、存在しないパスを「触った」と表示する）',
        file: 'v0/git.mjs',
        from: [
            '    if (sameSpelling) return rawChild.slice(rawParent.length + 1);',
            '    return c.slice(p.length + 1);',
        ].join('\n'),
        // 変異: 元の実装（段を混ぜる形）に戻す
        to: [
            "    const depth = c.slice(p.length + 1).split('/').length;",
            "    const orig = rawChild.split('/');",
            '    if (orig.length < depth) return null;',
            "    return orig.slice(orig.length - depth).join('/');",
        ].join('\n'),
        gone: 'if (sameSpelling) return rawChild.slice',
        pattern: 'junction が段を跨いでも',
        testFile: 'v0/paths.test.mjs',
    },
    {
        name: 'transcript-cwd-next-candidate',
        why: '最新の1本で cwd が読めないと諦める（cwd を持たない 112B のスタブが最新だと、'
            + '同じ dir の 182MB の実セッションを丸ごと捨てて「記録なし」と嘘をつく #36）',
        file: 'v0/transcript.mjs',
        from: '        const candidates = files.slice(0, limits.maxCwdProbes);',
        to: '        const candidates = files.slice(0, 1);',
        gone: 'files.slice(0, limits.maxCwdProbes)',
        pattern: '最新の記録に cwd が無くても',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-cwd-grow',
        why: '先頭の窓を広げない（先頭レコードが 16KB を超えるとプロジェクトを黙って捨てる #36）',
        file: 'v0/transcript.mjs',
        from: '        if (r.cwd || !r.truncated || want >= max) return r.cwd;',
        to: '        return r.cwd;',
        gone: 'if (r.cwd || !r.truncated || want >= max)',
        pattern: '先頭レコードが窓より大きくても cwd を見つける',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-unknown-types-grow',
        why: '窓が全部「知らない種別」でも読み直さない'
            + '（実データに 304KB 連続する箇所があり、既定 256KB を超える #37）',
        file: 'v0/transcript.mjs',
        from: `            while (s.noneReason === 'no-known-records' && tail.truncated
                && want < limits.tailMaxBytes) {`,
        to: '            while (false) {',
        gone: "s.noneReason === 'no-known-records' && tail.truncated",
        pattern: '末尾が全部「知らない種別」でも読み直し',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-none-reason',
        why: '「記録が無い」と「抽出できなかった」を同じ値で表す'
            + '（稼働中のエージェントに「走らせた記録がありません」と断言する #37）',
        file: 'v0/transcript.mjs',
        from: `        out.noneReason = !hadLines ? 'empty'
            : out.scanned === 0 ? 'no-known-records'
                : 'no-timestamp';`,
        to: "        out.noneReason = 'empty';",
        gone: "out.scanned === 0 ? 'no-known-records'",
        pattern: '末尾が全部「知らない種別」でも読み直し',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-path-clip',
        why: 'パスに上限を掛けない（--watch-agents だけで 12件 × 4096 ≒ 48KB の任意テキストが'
            + '発話用のフラグを経由せずに出る #38）',
        file: 'v0/transcript.mjs',
        from: '    if (rel.length <= max) return { path: rel, outside: false, clipped: false };',
        to: '    return { path: rel, outside: false, clipped: false };',
        gone: 'if (rel.length <= max)',
        pattern: '長いパスは切って、切ったことを伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-path-clip-notice',
        why: '切ったことを告知しない（切れたパスが「開けるパス」に見え、'
            + '「そのファイルを触った」という誤読になる）',
        file: 'v0/transcript.mjs',
        from: '    return { path: `${rel.slice(0, max)}…`, outside: false, clipped: true };',
        to: '    return { path: `${rel.slice(0, max)}`, outside: false, clipped: false };',
        gone: 'outside: false, clipped: true',
        pattern: '長いパスは切って、切ったことを伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-iso-strict',
        why: 'timestamp の形の検証を Date.parse だけに戻すと自由文が通る'
            + '（Date.parse は "INJECT-SECRET-12345" を西暦 12345 年として受け入れる）',
        file: 'v0/transcript.mjs',
        from: '    if (typeof v !== \'string\' || !ISO_RE.test(v)) return null;',
        to: '    if (typeof v !== \'string\') return null;',
        gone: 'ISO_RE.test(v)',
        pattern: '壊れた timestamp は落とす',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-text-capability',
        why: '--allow-transcript-text なしで発話が payload に載る',
        file: 'v0/server.mjs',
        // ⚠️ secrets を渡すようにして引数が複数行になったので字面が変わった
        from: '                allowText: opts.allowTranscriptText,',
        to: '                allowText: true,',
        gone: 'allowText: opts.allowTranscriptText',
        pattern: '自由文は payload に1文字も入らない',
    },
    {
        name: 'transcript-enum-value',
        why: 'mode / ツール名をそのまま払い出すと、形式が変わったとき自由文が通る',
        file: 'v0/transcript.mjs',
        from: '    return typeof v === \'string\' && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;',
        to: '    return typeof v === \'string\' ? v : null;',
        gone: 'v.length <= max',
        pattern: '列挙値として通らない形の mode',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-outside-repo',
        why: 'リポジトリ外のパスをそのまま出す（他プロジェクトのパスが漏れる）',
        file: 'v0/git.mjs',
        from: '    if (!c.startsWith(`${p}/`)) return null;',
        to: '    if (false) return null;',
        gone: '!c.startsWith(',
        pattern: 'リポジトリ外のパスは出さず',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        // 🚨 7回目のレビュー: `-z` の多トークンは再発トップの罠なのに、
        //    `git mv` がテストに1回も出てこなかった
        name: 'changed-files-rename',
        why: 'rename の3トークン（status NUL from NUL to）を2つとして読む'
            + '（status とパスの対応が全部ずれ、別のファイル名をカードに出す）',
        file: 'v0/git.mjs',
        from: `        if (status[0] === 'R' || status[0] === 'C') {
            const from = parts[i++], to = parts[i++];
            files.push({ status: status[0], path: toNFC(to ?? ''), from: toNFC(from ?? '') });
        } else {`,
        to: `        if (false) {
        } else {`,
        gone: "status[0] === 'R' || status[0] === 'C'",
        pattern: 'rename（R の3トークン）で後続のファイルがずれない',
    },
    {
        // 🚨 7回目のレビュー: fsmonitor と同じコミットで入った守りなのに、
        //    こちらだけテストも変異も1件も無かった
        name: 'diff-no-textconv',
        why: 'diff で --no-textconv を外す（リポジトリ設定 diff.<name>.textconv の'
            + 'コマンドが無認証の読み取り経路から走る = RCE）',
        file: 'v0/git.mjs',
        from: "        'diff', '--no-color', '--no-ext-diff', '--no-textconv',",
        to: "        'diff', '--no-color', '--no-ext-diff',",
        gone: "'--no-ext-diff', '--no-textconv'",
        pattern: 'diff がリポジトリ設定のコマンドを実行しない',
    },
    {
        name: 'diff-no-ext-diff',
        why: 'diff で --no-ext-diff を外す（diff.<name>.command の外部差分ツールが走る）',
        file: 'v0/git.mjs',
        from: "        'diff', '--no-color', '--no-ext-diff', '--no-textconv',",
        to: "        'diff', '--no-color', '--no-textconv',",
        gone: "'--no-color', '--no-ext-diff'",
        // ⚠️ 「`--no-textconv` があるから測れない」と書きかけたが、**実測では落ちる**
        //    （`diff.evil.command` が起動する）。推測でコメントを書かないこと。
        pattern: 'diff がリポジトリ設定のコマンドを実行しない',
    },
    {
        name: 'literal-pathspecs',
        why: 'pathspec magic で1ファイル指定が全体になる',
        file: 'v0/git.mjs',
        from: "    '--literal-pathspecs',\n",
        to: '',
        gone: "'--literal-pathspecs',",
        pattern: 'literal として扱う',
        testFile: 'v0/paths.test.mjs',
    },
    {
        // 🚨 8回目のレビュー: 案内の URL に実行トークンが載っていた
        //    （スマホの履歴・ブックマークに RCE の資格情報を置かせていた）
        name: 'bootstrap-url-read-only',
        why: '案内の URL に生トークンを載せる'
            + '（URL は履歴・ブックマーク・中継のログに残るので消せない）',
        file: 'v0/server.mjs',
        from: '        const readKey = cookieSecret();',
        to: '        const readKey = opts.token;   /* 変異: 生トークンを載せる */',
        gone: 'const readKey = cookieSecret();',
        pattern: '案内の URL の鍵では実行できない',
    },
    {
        name: 'read-secret-cannot-exec',
        why: '読み取り用の派生秘密でも exec の関門を通す（分界が消える）',
        file: 'v0/server.mjs',
        from: 'function presentedToken(req, url) {\n    return tokenMatches(req.headers[TOKEN_HEADER])',
        to: 'function presentedToken(req, url) {\n    if (presentedReadSecret(req, url)) return true;   /* 変異: 読み取り鍵も通す */\n'
            + '    return tokenMatches(req.headers[TOKEN_HEADER])',
        gone: 'function presentedToken(req, url) {\n    return tokenMatches',
        pattern: '案内の URL の鍵では実行できない',
    },
    {
        name: 'exec-argv-cookie-gate',
        why: 'Cookie だけの相手に exec の argv を出す'
            + '（コマンド行に秘密が載りうるので「read は読み取りまで」が崩れる）',
        file: 'v0/server.mjs',
        from: '                (state.execSessions && opts.requireAuth && !shown.ok)',
        to: '                (false)',
        gone: 'state.execSessions && opts.requireAuth && !shown.ok',
        pattern: 'argv は Cookie だけでは読めず',
    },
    {
        name: 'exec-argv-mask',
        why: 'exec の argv の秘密をマスクしない（`--token <値>` を打った回がそのまま出る）',
        file: 'v0/server.mjs',
        from: '                const masked = x.argv.map(a => maskSecrets(a, secretsForMasking()));',
        to: '                const masked = x.argv.map(a => ({ text: a, masked: false }));',
        gone: 'x.argv.map(a => maskSecrets(a, secretsForMasking()))',
        pattern: 'argv は Cookie だけでは読めず',
    },
    {
        // 🚨 トンネル越しは全部 127.0.0.1 に見えるので、中継の申告だけが手がかりになる
        name: 'audit-origin-xff',
        why: '中継の申告（x-forwarded-for）を記録しない'
            + '（トンネル越しだと全部 127.0.0.1 なので「誰が動かしたか」が分からない）',
        file: 'v0/server.mjs',
        from: '        xffReported: first ? first.slice(0, 64) : null,',
        to: '        xffReported: null,   /* 変異: 申告を捨てる */',
        gone: 'first ? first.slice(0, 64) : null',
        pattern: '中継の申告',
    },
    {
        name: 'audit-origin-no-spoof',
        why: '申告で peer を上書きする'
            + '（自己申告は誰でも書けるので、記録が嘘をつくようになる）',
        file: 'v0/server.mjs',
        from: '        peer: req.socket.remoteAddress ?? null,\n        host: req.headers.host ?? null,',
        to: '        peer: first ?? req.socket.remoteAddress ?? null,\n'
            + '        host: req.headers.host ?? null,',
        gone: 'peer: req.socket.remoteAddress ?? null,\n        host:',
        pattern: '中継の申告',
    },
    {
        // 🚨 実機で「1セッションの行が画面数枚分」になった形
        name: 'argv-summary-limit',
        why: '画面に出す argv に上限をかけない'
            + '（`node -e <スクリプト>` が丸ごと流れ、狭い画面で行が画面数枚分になる）',
        file: 'v0/argv.mjs',
        from: '        if (flat.length <= maxArg) return flat;',
        to: '        return flat;   /* 変異: 引数を縮めない */',
        gone: 'flat.length <= maxArg',
        pattern: '巨大な引数を縮め',
        testFile: 'v0/argv.test.mjs',
    },
    {
        name: 'argv-summary-keeps-tail',
        why: '先頭から一律に切る（末尾のフラグが消え、何のモードで動いているか分からなくなる）',
        file: 'v0/argv.mjs',
        from: "    let text = parts.join(' ');",
        to: "    let text = list.join(' ');   /* 変異: 引数ごとの縮めを捨てる */",
        gone: "let text = parts.join(' ')",
        pattern: '巨大な引数を縮め',
        testFile: 'v0/argv.test.mjs',
    },
    {
        // 🚨 監視盤（N 個のエージェントを1画面で見る）の守り
        name: 'monitor-requires-exec',
        why: '全セッションの状態と出力を exec の関門なしで返す'
            + '（出力はコマンドの結果なので、read だけの相手に渡ると分界が崩れる）',
        file: 'v0/server.mjs',
        from: "        if (url.pathname === '/api/v0/exec/list') {\n"
            + '            if (!await gateExec(req, res)) return;',
        to: "        if (url.pathname === '/api/v0/exec/list') {",
        gone: "'/api/v0/exec/list') {\n            if (!await gateExec",
        pattern: '全セッションの状態と最後の出力',
    },
    // -----------------------------------------------------------------
    // 🚨 9回目のレビュー / #50・#51: 監視盤は「どれに打つか」を決める盤なので、
    //    見分けと最後の出力が壊れると**誤操作**と**判断不能**に直結する。
    // -----------------------------------------------------------------
    {
        name: 'monitor-row-id-tag',
        why: '行にセッションを見分ける印（#id）を出さない'
            + '（同名 worktree が並ぶと入力先を間違える = 別のエージェントに文字が入る）',
        file: 'v0/app.html',
        from: "        el('span', 'note', `  #${idTag}`),",
        to: '        /* 変異: 見分ける印を出さない */',
        gone: "el('span', 'note', `  #${idTag}`)",
        script: 'v0/render-check.mjs',
    },
    {
        name: 'monitor-input-placeholder-id',
        why: '入力欄が送信先の id を出さない（打つ直前に確認できない）',
        file: 'v0/app.html',
        from: "      row.inp.placeholder = `${name} #${idTag} に送る（Enter）`;",
        to: "      row.inp.placeholder = `送る（Enter）`;   /* 変異: 送信先を出さない */",
        gone: "`${name} #${idTag} に送る",
        script: 'v0/render-check.mjs',
    },
    {
        // ⚠️ ラベルの一意化は純関数なので unit で測る（衝突する worktree を
        //    実ブラウザの仕込みに作るより、こちらの方が確実で速い）。
        name: 'monitor-label-unique',
        why: '見出しを basename だけにする（同名 worktree が区別できない）',
        file: 'v0/dirlabel.mjs',
        from: '            if (depth[i] < segs[i].length) { depth[i]++; grew = true; }',
        to: '            /* 変異: 親を足さない = basename のまま */',
        gone: 'if (depth[i] < segs[i].length) { depth[i]++; grew = true; }',
        pattern: 'basename が衝突したら',
        testFile: 'v0/dirlabel.test.mjs',
    },
    {
        // 🚨 #51: 応答を書いている最中の断片で本文が隠れていた
        name: 'glance-writing-fragment',
        why: '書き込み中の断片をそのまま「最後の出力」として出す'
            + '（並列で見ている最中に限って直前の応答が読めない = 盤の目的が消える）',
        file: 'v0/chatfilter.mjs',
        from: '            if (i === lines.length - 1 && partialTail && lines.length > 1) {',
        to: '            if (false) {   /* 変異: 断片をそのまま出す */',
        gone: 'i === lines.length - 1 && partialTail',
        pattern: '書き込み中の断片で本文を隠さない',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        // ⚠️ 「飛ばしたことを告げる」側も測る（黙って捨てるのが一番悪い）
        name: 'glance-writing-announce',
        why: '断片を飛ばしたことを告げない（黙って捨てる）',
        file: 'v0/app.html',
        from: "    + (g.writing ? '  ← 応答を書いています' : '')",
        to: '    + \'\'   /* 変異: 飛ばしたことを告げない */',
        gone: "g.writing ? '  ← 応答を書いています'",
        script: 'v0/render-check.mjs',
        // ⚠️ 実ブラウザで断片の状態を作るのは難しい（サーバの払い出しに依存）。
        //    SURVIVED なら、告知を測る検査を chatfilter 側（unit）に寄せること。
        defensive: '断片が出ている瞬間を実ブラウザで固定するのが難しい。'
            + '告知の有無は chatfilter の unit（writing フラグ）で測っている',
    },
    {
        name: 'monitor-last-output',
        why: '最後の出力を返さない'
            + '（購読しないと状況が分からず、どのセッションに打てばよいか判断できない）',
        file: 'v0/execsession.mjs',
        from: '        for (let i = this.log.records.length - 1; i >= 0; i--) {',
        to: '        for (let i = -1; i >= 0; i--) {',
        gone: 'this.log.records.length - 1; i >= 0',
        pattern: '全セッションの状態と最後の出力',
    },
    {
        // 🚨 **レイアウトの検査にも変異を1件も掛けていなかった**（render だけ掛けていた）。
        //    「実ブラウザの検査も突然変異に掛ける」と書いておきながら、
        //    layout-check.mjs を動かす変異が0件 = 検査が壊れても誰も気付かない状態。
        name: 'probe-token-passthrough',
        why: 'レイアウト検査のハーネスにトークンを渡さない'
            + '（実行系の UI が「使えません」の一文になり、'
            + 'コマンドバーも監視盤も描かれないまま「測った」ことになる）',
        file: 'v0/server.mjs',
        from: '                presentedToken(req, url) ? opts.token : null));',
        to: '                null));',
        gone: 'presentedToken(req, url) ? opts.token : null));',
        script: 'v0/layout-check.mjs',
    },
    {
        name: 'hidden-author-rule',
        why: '作者スタイルの [hidden] 規則を消す（UA の [hidden]{display:none} は'
            + '.cmdbar の display:flex に負けるので、送れないのに入力欄が描かれる）',
        file: 'v0/app.html',
        from: '  [hidden] { display: none !important; }',
        to: '  /* 変異: 作者側の [hidden] 規則を消す */',
        gone: 'display: none !important',
        // ⚠️ **`!important` を外すだけでは落ちない（実測で SURVIVED）。**
        //    `[hidden]` は `.cmdbar` より**後ろ**にあるので、同じ詳細度なら
        //    順序で勝つ。守りの本体は「作者スタイルに規則があること」で、
        //    `!important` は順序が入れ替わったときの保険（順序が守りになっている例）。
        script: 'v0/layout-check.mjs',
    },
    // ---- ペインの並び替え（ドラッグ移動）。
    //      🚨 **保存も復元も「行は残っているのに到達不能」という形で壊せる**ので、
    //      layout-check が実ブラウザで掴んで動かし、自動更新を1回通し、
    //      再読込してから並びを読む。ここはその検査が本当に落ちるかの確認。
    {
        name: 'pane-order-save',
        why: 'ドラッグを確定しても localStorage に保存しない'
            + '（再読込で並びが既定に戻る = 毎回並べ直すことになる）',
        file: 'v0/app.html',
        from: '      p.classList.remove(\'dragging\');\n      saveLayout();',
        to: '      p.classList.remove(\'dragging\');\n      /* 変異: 並びを保存しない */',
        gone: '      saveLayout();',
        script: 'v0/layout-check.mjs',
    },
    {
        name: 'pane-order-restore',
        why: '起動時に保存された並びを読まない（保存はするので、'
            + '「効いているのに次に効かない」形の壊れ方になる）',
        file: 'v0/app.html',
        from: 'let paneLayout = parseLayout(readStoredLayout());',
        to: 'let paneLayout = parseLayout(null);   /* 変異: 保存を読まない */',
        gone: 'parseLayout(readStoredLayout())',
        script: 'v0/layout-check.mjs',
    },
    {
        name: 'pane-order-apply',
        why: '置き直すときに保存された順序を無視する'
            + '（掴んで動かしても列の中の位置が変わらない）',
        file: 'v0/app.html',
        from: '    placePanes(hostEl(h), orderedIds(paneLayout, h, ids));',
        to: '    placePanes(hostEl(h), ids);',
        gone: 'orderedIds(paneLayout, h, ids)',
        script: 'v0/layout-check.mjs',
    },
    {
        // ⚠️ 最初は ensurePane 側（自動更新が既定の入れ物へ戻す形）に変異を置いたが
        //    **SURVIVED した**。applyLayout が置き直すので観測可能な差が出ない
        //    = そこに守りを二重に置く意味が無い（守りごと消して、置き場所の決定を
        //    applyLayout の1箇所に集めた）。変異は**守りの本体**に当てる。
        name: 'pane-order-host-override',
        why: '保存された移動先ではなく既定の入れ物を使う（列をまたぐ移動ができない）',
        file: 'v0/app.html',
        from: '    byHost.get(hostOf(paneLayout, id, obj.defaultHost))?.push(id);',
        to: '    byHost.get(obj.defaultHost)?.push(id);',
        gone: 'hostOf(paneLayout, id, obj.defaultHost)',
        script: 'v0/layout-check.mjs',
    },
    {
        // 🚨 layout-check の合成 pointerup は click を生成しないので、
        //    こちらは render-check（ブラウザと同じ順で click まで撃つ）で測る。
        name: 'pane-drag-click-suppress',
        why: 'ドラッグ直後の click を捨てない'
            + '（並べ替えるたびにヘッダの開閉が起きてペインが畳まれる）',
        file: 'v0/app.html',
        from: '    if (drag.moved) { drag.moved = false; return; }',
        to: '    /* 変異: ドラッグ直後の click を捨てない */',
        gone: 'if (drag.moved) { drag.moved = false; return; }',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'pane-default-rank',
        why: '既定の並びを「render が求めた順」にしない'
            + '（後から増えた worktree のコンソールが、アルファベット順の途中ではなく'
            + '必ず末尾に付く。以前 arrangeRow が毎回並べ直していた守り）',
        file: 'v0/app.html',
        from: '  obj.defaultRank = paneSeq++;',
        to: '  obj.defaultRank = -paneSeq++;',
        gone: 'obj.defaultRank = paneSeq++;',
        script: 'v0/layout-check.mjs',
    },
    {
        name: 'pane-order-forget-cap',
        why: '覚えている id を上限で削らない'
            + '（使い捨ての worktree の id が localStorage に永久に溜まる）',
        file: 'v0/panelayout.mjs',
        from: '    if (total <= cap) return layout;',
        to: '    return layout;   /* 変異: 上限を無くす */',
        gone: 'if (total <= cap) return layout;',
        pattern: 'pruneLayout は上限を超えたときだけ',
        testFile: 'v0/panelayout.test.mjs',
    },
    {
        name: 'pane-order-single-host',
        why: '入れ物をまたいで移したとき、元の入れ物の記録から消さない'
            + '（1つの id が2箇所に載り、hostOf が PANE_HOSTS の順という'
            + '無関係な理由で答えを決める）',
        file: 'v0/panelayout.mjs',
        from: '        out[h] = h === hostId ? [...ids] : (layout[h] ?? []).filter(id => !moved.has(id));',
        to: '        out[h] = h === hostId ? [...ids] : [...(layout[h] ?? [])];',
        gone: 'filter(id => !moved.has(id))',
        pattern: 'setHostOrder は移した id を元の入れ物の記録から消す',
        testFile: 'v0/panelayout.test.mjs',
    },
    {
        name: 'monitor-glance-raw',
        why: '会話の最後の応答を解釈せず生の stream-json を返す'
            + '（監視盤に JSON が並び、「どれが待っているか」が読めない）',
        file: 'v0/chatfilter.mjs',
        from: '        const got = chatRecordLines(r);',
        to: '        const got = [{ cls: "", text: lines[i] }];',
        gone: 'const got = chatRecordLines(r);',
        pattern: 'chatGlance',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        // 🚨 8回目のレビューの SERIOUS: 末尾の非 JSON 行（stderr / 「⚠ 停止しました」）を
        //    飛ばして**数分前の応答を「最後の出力」として出していた**。
        //    しかも interpreted:true なので「← 解釈できない行」も付かない =
        //    止まったのに動いているように見える（この盤で一番効く嘘）。
        name: 'monitor-glance-tail-skipped',
        why: '末尾の解釈できない行を飛ばす（終わった理由が消え、古い応答が最後の出力になる）',
        file: 'v0/chatfilter.mjs',
        // ⚠️ #73 で `break` が消えたので、行の形が変わった。
        //    「見た行を返す」を `continue` にすると**全部飛ばして空になる**
        from: '            return { text: lines[i], interpreted: false, writing };\n        }',
        to: '            continue;   /* 変異: 末尾の生テキストも飛ばす */\n        }',
        gone: 'return { text: lines[i], interpreted: false, writing };\n        }',
        pattern: '断片しか無いときは断片を出す',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'monitor-glance-keeps-raw',
        // 🚨 #73 で守りの本体が変わった。以前は「fallback が末尾の行を返す」ことを
        //    固定していたが、その fallback が**飛ばした断片**を返す誤りだった。
        //    今は「見た行をその場で返す」のが守りなので、そこに当てる。
        why: '解釈できない完全な行を返さず、飛ばした断片を最後の出力にする（停止の告知や stderr が画面から消える）',
        file: 'v0/chatfilter.mjs',
        from: '            return { text: lines[i], interpreted: false, writing };',
        to: '            break;   /* 変異: 見た行を返さず fallback に落とす */',
        gone: 'return { text: lines[i], interpreted: false, writing };',
        pattern: '断片の直前が JSON でない完全な行でも',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'monitor-last-output-budget',
        why: '上限を実測より小さく戻す'
            + '（claude の result 行は 7813 文字あったので「応答おわり」が必ず壊れる）',
        file: 'v0/execsession.mjs',
        from: '    lastOutput(max = 8000) {',
        to: '    lastOutput(max = 2000) {',
        gone: 'lastOutput(max = 8000',
        pattern: '長い result 行でも解釈できる',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'chat-skip-count-total',
        why: '出さなかった件数の合計を出さない'
            + '（数えたまま黙って終わる = 「捨てない」約束が破れる）',
        file: 'v0/chatfilter.mjs',
        from: "        line('d', `  （出さなかった行: ${parts.join(' / ')}）\\n`);",
        to: '        /* 変異: 合計を出さない */',
        gone: '出さなかった行: ${parts',
        pattern: '同じ告知は種別ごとに1回だけ',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        // 🚨 実機で「会話の間に構造データの告知が刺し込まれ続ける」と指摘された形
        name: 'chat-skip-once-per-kind',
        why: '告知を種別ごとに1回に絞らない'
            + '（user の再送や rate_limit_event が応答の合間に挟まり、会話が読めない）',
        file: 'v0/chatfilter.mjs',
        from: '            const seen = skipped.get(o.text);',
        to: '            const seen = undefined;   /* 変異: 毎回告知する */',
        gone: 'const seen = skipped.get(o.text);',
        pattern: '応答の合間に挟まる告知',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'chat-input-envelope',
        why: '送った行を封筒のまま出す'
            + '（`▸ {"type":"user","message":…}` になり、打った本人にも読めない）',
        file: 'v0/chatfilter.mjs',
        from: "    return t.trim() ? t.trim() : null;",
        to: '    return null;   /* 変異: 本文を取り出さない */',
        gone: 't.trim() ? t.trim() : null',
        pattern: '封筒から本文だけ取る',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'monitor-last-output-lines',
        why: '最後の出力の空白を潰す'
            + '（会話モードの1行1レコード JSON が壊れ、監視盤が解釈できなくなる）',
        file: 'v0/execsession.mjs',
        from: "            acc = String(r.d ?? '') + acc;",
        to: "            acc = String(r.d ?? '').replace(/\\s+/g, ' ') + acc;",
        gone: "acc = String(r.d ?? '') + acc;",
        pattern: '最後の出力は行の構造を保つ',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        // 🚨 8回目のレビューの BLOCKING: 1ペインで2本購読できた
        //    （入力が見ていない方に届き、片方の exit で「停止」表示なのに
        //     もう1本が同じ端末に出力を続ける）
        name: 'console-single-subscription',
        why: '新しく購読するときに前の購読を切らない'
            + '（2本が同じ端末に混ざり、入力が見ていない方に届く）',
        file: 'v0/app.html',
        from: '    if (liveAbort) {\n      try { liveAbort(); } catch { /* 既に閉じている */ }\n      liveAbort = null;\n    }',
        to: '    /* 変異: 前の購読を切らない */',
        gone: 'if (liveAbort) {',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 **CI の macOS が捕まえた本物のバグ。** 購読を abort しても、書き手は
        //    `requestAnimationFrame` でまとめて流すので、消した端末に古い行が入る。
        //    ⚠️ 手元（Windows）では rAF の順序が違って**再現しない**ので、
        //       この変異は darwin / linux でしか殺せない（SKIP を緑と読まない）。
        name: 'console-stale-writer',
        why: '古い購読の書き込みを捨てない'
            + '（切替で端末を消しても rAF の flush で古い行が入り、2本が混ざる）',
        file: 'v0/app.html',
        from: '    if (isCurrent && !isCurrent()) { queue = []; return; }',
        to: '    /* 変異: 古い購読の書き込みも通す */',
        gone: 'if (isCurrent && !isCurrent()) { queue = []; return; }',
        // 🚨 **以前は `platforms: ['darwin','linux']` で、しかも linux で SURVIVED した。**
        //    門が `line()`（enqueue の時）にあったので、**切替の前に溜まっていた行**は
        //    素通りしていた = 門の位置が間違っていた。門を flush 側に移し、
        //    検査は `__kjpHoldFlush` で「溜まっている状態」を決定的に作るので、
        //    プラットフォームを限定せずに測れる。
        script: 'v0/render-check.mjs',
    },
    {
        name: 'console-stale-notifications',
        why: '古い購読からの通知を捨てない'
            + '（終わった方の exit で「停止」表示になり、走っている方を止められなくなる）',
        file: 'v0/app.html',
        from: '      if (myGen !== gen) return;   // 古い購読の通知は捨てる',
        to: '      /* 変異: 古い通知も通す */',
        gone: 'if (myGen !== gen) return;',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'console-switch-label',
        why: '購読中でも「再接続」と表示する（両方見られると誤解させる）',
        file: 'v0/app.html',
        from: "      const re = el('button', null, paneObj.sessionId ? '切替' : '再接続');",
        to: "      const re = el('button', null, '再接続');",
        gone: "paneObj.sessionId ? '切替' : '再接続'",
        script: 'v0/render-check.mjs',
    },
    {
        name: 'console-input-target',
        why: '入力欄に送信先を出さない（どのセッションに打っているか分からない）',
        file: 'v0/app.html',
        from: "    const to = st.sessionId ? ` → ${String(st.sessionId).slice(0, 8)}` : '';",
        to: "    const to = '';   /* 変異: 送信先を出さない */",
        gone: 'st.sessionId ? ` → ${String(st.sessionId)',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 実機で「止まったように見える」と読まれた形（沈黙 = 停止ではない）
        name: 'exec-heartbeat',
        why: '出力が来ない間の心拍を出さない'
            + '（claude が長い応答を書いている間、画面が沈黙して止まったように見える）',
        file: 'v0/app.html',
        from: '    if (beatTimer === null) beatTimer = setInterval(tickBeat, 1000);',
        to: '    /* 変異: 心拍を刻まない */',
        gone: 'beatTimer = setInterval(tickBeat, 1000)',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'exec-heartbeat-stops',
        why: '終了しても心拍を消さない（止まったのに「実行中」と言い続ける）',
        file: 'v0/app.html',
        from: '    if (st.running) startBeat();\n    else stopBeat();',
        to: '    if (st.running) startBeat();',
        gone: 'else stopBeat();',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 8回目のレビューの SERIOUS: `--require-auth`（= `--allow-host` の
        //    トンネル = スマホから使う既定の構成）では、`load()` がトークンを
        //    付けないので `execSessions` が常に null で返り、**走っているセッションと
        //    再接続口が黙って消えていた**（#17 の目的が一番使う経路で到達不能）。
        //    ⚠️ 字面では測れない（行は残る）。render-check を `--require-auth` で
        //    走らせて、再接続の候補が実際に出ることで測る。
        name: 'state-fetch-token-header',
        why: 'state の取得にトークンを付けない'
            + '（--require-auth では execSessions が常に null = 再接続口が消える）',
        file: 'v0/app.html',
        // ⚠️ **`load()` の1行に固定する。** `/api/v0/repos` の取得にも同じ形の
        //    ヘッダ付けが増えたので、この1行だけでは2箇所に当たって SKIP に落ちた
        //    （守りが未検証のまま静かに続く。--dry が拾った）。
        //    直前の fetch 行ごと含めて一意にする。
        from: "    const res = await fetch(api('/api/v0/state', force ? { fresh: '1' } : null),\n"
            + '      session.token ? { headers: { [session.tokenHeader]: session.token } } : {});',
        to: "    const res = await fetch(api('/api/v0/state', force ? { fresh: '1' } : null),\n"
            + '      {});   /* 変異: トークンを付けない */',
        gone: "api('/api/v0/state', force ? { fresh: '1' } : null),\n      session.token ?",
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 分界（Cookie / 読み取り用の鍵には exec の argv を渡さない）は緩めない。
        //    緩めない代わりに**落としたことを言う**のが守りの本体。
        name: 'sessions-hidden-notice',
        why: 'サーバが一覧を落としたことを画面に出さない'
            + '（読み取り用の鍵のタブで「1本も走っていない」と同じ見た目になる）',
        file: 'v0/app.html',
        from: `      resume.append(document.createTextNode(
        '⚠ このworktreeで走っているセッションの一覧は出せません'
        + '（読み取り用の鍵ではコマンド行を返さないため）。'
        + ' 実行の鍵を貼ると、走っているものと再接続口が出ます。'));`,
        to: '      /* 変異: 出せないことを言わない（黙って空にする） */',
        gone: 'このworktreeで走っているセッションの一覧は出せません',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'state-exec-sessions-hidden-flag',
        why: '一覧を落としたことをサーバが伝えない'
            + '（UI からは「1本も走っていない」と区別できない）',
        file: 'v0/server.mjs',
        from: '                    ? { ...state, execSessions: null, execSessionsHidden: true }',
        to: '                    ? { ...state, execSessions: null }',
        gone: 'execSessionsHidden: true',
        pattern: '読み取り用の鍵では走っているセッションを出さない',
    },
    {
        // 🚨 これは**実ブラウザでしか測れない**（字面では入力が消えるのが見えない）
        name: 'monitor-row-reuse',
        why: '自動更新のたびに監視盤の行を作り直す'
            + '（打っている途中の入力が消え、送信先の対象もずれる）',
        file: 'v0/app.html',
        from: '  const found = monitorRows.get(x.id);\n  if (found) return found;',
        to: '  const found = null;\n  if (found) return found;',
        gone: 'monitorRows.get(x.id);\n  if (found) return found;',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 取り込み（merge）は「衝突しないと分かっているもの」だけ実行する
        name: 'merge-predicted-clean',
        why: '衝突すると予測されたものも取り込む'
            + '（作業ツリーが衝突状態になり、UI が「取り込みました」と言う）',
        file: 'v0/server.mjs',
        from: '            if (pre.clean !== true) {',
        to: '            if (false) {',
        gone: 'if (pre.clean !== true)',
        pattern: '衝突しないものは取り込め、衝突するものは拒否する',
    },
    {
        name: 'merge-driver-refused',
        why: 'カスタム merge driver があるリポジトリでも取り込む'
            + '（driver はリポジトリ設定の任意コマンドを起動する = 読み書きの capability で RCE）',
        file: 'v0/server.mjs',
        // ⚠️ `if (drivers.length) {` は衝突予測側にもある（499行）。**一意にする**
        from: '            const drivers = await mergeDriverNames(wt.path);\n'
            + '            if (drivers.length) {',
        to: '            const drivers = await mergeDriverNames(wt.path);\n'
            + '            if (false) {',
        gone: 'await mergeDriverNames(wt.path);\n            if (drivers.length)',
        pattern: 'カスタム merge driver があるリポジトリでは実行しない',
    },
    {
        name: 'merge-dirty-refused',
        why: 'dirty な作業ツリーでも取り込む（未コミットの変更を巻き込む）',
        file: 'v0/server.mjs',
        from: '            if (st.changed > 0 || st.unmerged > 0) {',
        to: '            if (false) {',
        gone: 'st.changed > 0 || st.unmerged > 0',
        pattern: '衝突しないものは取り込め、衝突するものは拒否する',
    },
    {
        // 🚨 8回目のレビュー: 成功経路だけが数え直していた（失敗経路は嘘を返す）
        name: 'merge-failed-recount',
        why: 'merge が途中で失敗したときに数え直さない'
            + '（MERGE_HEAD と staged 変更を残したまま「拒否しました」と返す）',
        file: 'v0/server.mjs',
        from: '                const seqAfter = await sequencerState(wt.path).catch(() => null);\n'
            + '                const stAfter = await worktreeStatus(wt.path).catch(() => null);',
        to: '                const seqAfter = null, stAfter = null;   /* 変異: 数え直さない */',
        gone: 'const seqAfter = await sequencerState(wt.path).catch(() => null)',
        pattern: 'merge が途中で失敗したら',
    },
    {
        name: 'merge-failed-message',
        why: '半端な状態が残っても「git が取り込みを拒否しました」と言う（嘘）',
        file: 'v0/server.mjs',
        from: "                const message = leftover.counted === false",
        to: '                const message = `git が取り込みを拒否しました: ${err.message}`;\n'
            + '                if (false) void (leftover.counted === false',
        gone: '                const message = leftover.counted === false',
        pattern: 'merge が途中で失敗したら',
    },
    {
        name: 'merge-failed-cache',
        why: '失敗経路でキャッシュを捨てない'
            + '（作業ツリーは半端なのに、画面は TTL の間 clean のまま）',
        file: 'v0/server.mjs',
        // ⚠️ キャッシュがリポジトリごとになったので字面が変わった（--dry で検出）
        from: '                cachedByRepo.delete(repo);\n'
            + '                const seqAfter = await sequencerState(wt.path).catch(() => null);',
        to: '                /* 変異: キャッシュを捨てない */\n'
            + '                const seqAfter = await sequencerState(wt.path).catch(() => null);',
        gone: 'cachedByRepo.delete(repo);\n                const seqAfter =',
        pattern: 'merge が途中で失敗したら',
    },
    {
        name: 'merge-outcome-reload',
        why: '取り込みが失敗したときに画面を数え直さない'
            + '（半端な状態が残っているのに clean のまま見える）',
        file: 'v0/mergeresult.mjs',
        from: '        // 🚨 失敗でも数え直す。断られた理由が「画面が古い」ことである場合も多い\n'
            + '        reload: true,',
        to: '        // 🚨 失敗でも数え直す。断られた理由が「画面が古い」ことである場合も多い\n'
            + '        reload: false,',
        gone: 'ことである場合も多い\n        reload: true,',
        pattern: '半端な状態が残ったら',
        testFile: 'v0/mergeresult.test.mjs',
    },
    {
        name: 'merge-outcome-sticky',
        why: '半端な状態の告知を再描画で消える場所にしか出さない'
            + '（load(true) でペインが作り直されて文字が消え、「clean」に見える）',
        file: 'v0/mergeresult.mjs',
        from: '        sticky: (dirty || unknown) ? message : null,',
        to: '        sticky: null,   /* 変異: 消えない告知に回さない */',
        gone: 'sticky: (dirty || unknown)',
        pattern: '半端な状態が残ったら',
        testFile: 'v0/mergeresult.test.mjs',
    },
    {
        name: 'merge-no-hooks',
        why: 'merge で hooks を通す（post-merge / commit-msg はリポジトリ設定のコードなので、'
            + 'HTTP から任意コード実行になる）',
        file: 'v0/server.mjs',
        from: "                    '-c', `core.hooksPath=${emptyHooks}`,",
        to: '                    /* 変異: hooks を通す */',
        gone: 'core.hooksPath=${emptyHooks}',
        pattern: 'merge が hooks を実行しない',
    },
    {
        name: 'merge-ref-validation',
        why: 'merge の ref を検証しない（`--force` 等のオプション注入と reflog 経由）',
        file: 'v0/server.mjs',
        from: '            if (!isSafeRef(branch)) { denyJson(res, 400, `ref が不正です: ${branch}`); return; }',
        to: '            /* 変異: ref を検証しない */',
        gone: 'if (!isSafeRef(branch))',
        pattern: '衝突しないものは取り込め、衝突するものは拒否する',
    },
    {
        name: 'checkout-ref-validation',
        why: 'オプション名のブランチで未コミットの変更が破棄される',
        file: 'v0/server.mjs',
        from: '            if (!isSafeRef(ref)) { denyJson(res, 400, `ref が不正です: ${ref}`); return; }\n',
        to: '',
        // ⚠️ merge 側にも `ref が不正です` ができたので、**変数名まで含めて**一意にする
        //    （素の文字列だと外しても残っていて STALE になる。`--dry` で見つけた）
        gone: 'isSafeRef(ref)) { denyJson',
        pattern: 'オプション名のブランチ',
    },
    {
        name: 'sequencer-todo',
        why: 'sequencer/todo が残った状態の checkout を通してしまう',
        file: 'v0/git.mjs',
        from: "        sequencing: existsSync(p('sequencer/todo')),",
        to: '        sequencing: false,',
        gone: "existsSync(p('sequencer/todo'))",
        pattern: 'sequencer/todo が残っている',
    },
    {
        name: 'exec-capability',
        why: '--allow-exec なしで実行できてしまう',
        file: 'v0/server.mjs',
        from: '    if (!opts.allowExec) {',
        to: '    if (false) {',
        gone: '!opts.allowExec',
        pattern: '--allow-exec なしでは exec の経路が存在しない',
    },
    // ⚠️ `exec-slot-reserve` はここにあったが #17 で消した。
    //    `reserveExecSlot()` が `execRegistry.create()` に移ったため
    //    （守りが弱くなったのではなく、**後継が `exec-slot-reserve-sync`**）。
    // 孫プロセスの後始末は「木ごと kill」「stdio を destroy」
    // 「exit で拾う（close ではなく）」で守っている。
    // どれが実際に load-bearing かを個別に確かめる（まとめて1つの変異にすると
    // 「どれかが効いている」しか分からない）。
    {
        name: 'exec-kill-tree-posix',
        why: 'POSIX でプロセスグループごと殺さない（孫が残る）',
        // この経路は win32 では実行されない。ubuntu/macOS CI が検証する
        platforms: ['linux', 'darwin'],
        file: 'v0/server.mjs',
        from: "        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* グループが無い/既に死んでいる */ }",
        to: '        /* 変異: グループ kill をやめる */',
        gone: 'process.kill(-child.pid',
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    {
        name: 'exec-kill-tree-win',
        why: 'Windows で taskkill /T しない（孫が残る）',
        // taskkill は win32 にしか無い。POSIX では通らない経路
        platforms: ['win32'],
        file: 'v0/server.mjs',
        // ⚠️ 終了コードを見るようにしたので字面が変わった（`child.pid` → `pid`）
        from: "                execFile('taskkill', ['/PID', String(pid), '/T', '/F'],",
        to: "                execFile('taskkill', ['/PID', String(pid), '/F'],",
        gone: "'/T', '/F'",
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    {
        name: 'exec-stdio-destroy',
        why: '孫が stdio を握ったまま応答が閉じられない',
        // Windows では taskkill /T が孫まで殺すのでパイプが閉じ、これは冗長になる。
        // taskkill が失敗した場合の保険として残す（検証されていないことを明示する）
        defensive: 'taskkill /T が効く環境では冗長。失敗時の保険',
        file: 'v0/server.mjs',
        from: '    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* noop */ }',
        to: '    /* 変異: stdio の destroy をやめる */',
        gone: 'child.stdout?.destroy()',
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    // ⚠️ `exec-guard-timer`（exit が来なくても枠を返す保険タイマー）も #17 で消した。
    //    **順序を変えたことで不要になった。** 以前は killTree → exit 待ち →
    //    来なければ保険、という順だったが、今は台帳の sweep と明示的な kill が
    //    どちらも「先に finish() してから killTree」する。枠は exit を待たずに戻る。
    {
        name: 'merge-driver',
        why: '衝突予測が custom merge driver を実行する（任意コード実行）',
        file: 'v0/git.mjs',
        from: "    const kill = driverNames.flatMap(n => ['-c', `merge.${n}.driver=false`]);",
        to: '    const kill = [];',
        gone: 'driver=false',
        pattern: 'custom merge driver を実行しない',
    },
    {
        name: 'blob-reflog',
        why: 'reflog 経由で捨てたコミットの中身が読める',
        file: 'v0/git.mjs',
        from: "    if (r.includes('@{') || r === '@') return false;\n",
        to: '',
        gone: "r.includes('@{')",
        pattern: 'reflog 経由',
    },
    {
        name: 'worktree-allowlist',
        why: '既知でない worktree を cwd にできる',
        file: 'v0/server.mjs',
        // exec 側の allowlist だけを外す。`bail()` があるので checkout 側とは区別できる。
        // 単にメッセージを変えるのでは駄目で、**照合を通してしまう**形にする必要がある。
        from: `                wt = worktrees.find(w => samePath(w.path, wantPath));
                if (!wt) { bail(400, \`既知の worktree ではありません: \${wantPath}\`); return; }`,
        to: `                /* 変異: allowlist を外し、要求されたパスをそのまま使う */
                wt = worktrees.find(w => samePath(w.path, wantPath))
                    ?? { path: wantPath, label: wantPath, bare: false, prunable: false };`,
        gone: 'bail(400, `既知の worktree ではありません',
        pattern: 'exec は既知の worktree 以外を cwd にしない',
    },
    {
        name: 'swimlane-dedup',
        why: '同じコミットを指すレーンが畳まれずレーンが漏れる',
        file: 'v0/swimlanes.mjs',
        from: `        const push = node => {
            const at = output.findIndex(o => o.id === node.id);
            if (at !== -1) return at;
            output.push(node);
            return output.length - 1;
        };`,
        to: `        const push = node => {
            output.push(node);
            return output.length - 1;
        };`,
        gone: 'const at = output.findIndex(o => o.id === node.id);',
        pattern: 'converging',
        testFile: 'v0/swimlanes.test.mjs',
    },
    {
        name: 'ndjson-partial-line',
        why: 'JSON の行が chunk 境界で割れたときに落とす',
        file: 'v0/ndjson.mjs',
        from: "            buf = lines.pop() ?? '';",
        to: '            // 変異: 持ち越しをやめる',
        gone: "buf = lines.pop()",
        pattern: 'chunk 境界で割れても復元する',
        testFile: 'v0/ndjson.test.mjs',
    },
    {
        name: 'ndjson-multibyte',
        why: 'マルチバイトが chunk 境界で割れる',
        file: 'v0/ndjson.mjs',
        from: 'buf += decoder.decode(value, { stream: true });',
        to: 'buf += decoder.decode(value);',
        gone: '{ stream: true }',
        pattern: '3バイト文字が chunk 境界で割れても壊れない',
        testFile: 'v0/ndjson.test.mjs',
    },
    {
        name: 'mergeplan-independent-set',
        why: '提案の塊に衝突するペアが入る',
        file: 'v0/mergeplan.mjs',
        from: '        if (conflictsWithTaken.length) continue;',
        to: '        if (false) continue;',
        gone: 'if (conflictsWithTaken.length) continue;',
        pattern: '塊の中身は互いに衝突しない',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        name: 'samepath-realpath',
        why: '8.3 短縮名 / シンボリックリンクを解決しない',
        file: 'v0/git.mjs',
        from: '            t = realpathSync.native(t);',
        to: '            t = t;',
        // ⚠️ normPath 側にも同じ式があるので、インデントまで含めて一意にする
        gone: '            t = realpathSync.native(t);',
        pattern: 'シンボリックリンク越し',
        testFile: 'v0/paths.test.mjs',
    },

    // -----------------------------------------------------------------------
    // 🔒 最小エディタ（/api/v0/file と /api/v0/write）。
    //    **v0 で初めて「作業ツリーにファイルの中身を書く」経路**なので、
    //    門を1つずつ外して、対応するスモークテストが実際に落ちることを確かめる。
    // -----------------------------------------------------------------------
    {
        name: 'write-auth-gate',
        why: '編集経路の認可を外す（トークン無し・GET・別サイト起点で作業ツリーに書ける）',
        file: 'v0/server.mjs',
        // ⚠️ merge / checkout にも同じ呼び出しがあるので、末尾のコメントで一意にする
        from: '            if (!await gateMutation(req, res)) return;   // ← 門1: 認可\n',
        to: '',
        gone: '// ← 門1: 認可',
        pattern: 'write: 関門',
    },
    {
        name: 'write-gate-order',
        why: '認可をパス・追跡チェックの**後ろ**に回す'
            + '（未認可の相手がエラーの違いから「そのパスが追跡されているか」を引き出せる）',
        // 🚨 順序そのものが守り。`--allow-exec` の門が自動生成より後ろにあって
        //    消えていたのと同じ型なので、**順序を変異で測る**。
        file: 'v0/server.mjs',
        from: '            if (!await gateMutation(req, res)) return;   // ← 門1: 認可\n',
        to: '',
        also: [{
            from: '            if (!t) return;                          // ← 応答は関門が書いている',
            to: '            if (!t) return;\n            if (!await gateMutation(req, res)) return;',
        }],
        gone: '// ← 門1: 認可',
        pattern: 'write: 門の順序',
    },
    // -----------------------------------------------------------------
    // 🚨 9回目のレビュー / #53: 大きさの上限に検査も変異も無かった。
    //    門は**開く側と書く側の2箇所**にあるので、両方を別々に測る。
    // -----------------------------------------------------------------
    {
        name: 'edit-open-size-limit',
        why: '大きすぎるファイルをそのまま開く'
            + '（100MB のファイルを読んで母艦のメモリを埋められる）',
        file: 'v0/server.mjs',
        from: '        if (st.size > MAX_EDIT_BYTES) {',
        to: '        if (false) {   /* 変異: 大きさを見ない */',
        gone: 'if (st.size > MAX_EDIT_BYTES) {',
        pattern: '512KB を超える中身',
    },
    {
        name: 'edit-write-size-limit',
        why: '大きすぎる中身をそのまま書く（作業ツリーを埋められる）',
        file: 'v0/server.mjs',
        from: '                if (next.length > MAX_EDIT_BYTES) {',
        to: '                if (false) {   /* 変異: 大きさを見ない */',
        gone: 'if (next.length > MAX_EDIT_BYTES) {',
        pattern: '512KB を超える中身',
    },
    {
        // ⚠️ 「断る」だけを測ると、境界の向きを変える変異を見逃す
        //    （実用的な大きさまで断るようになっても検査が緑になる）。
        name: 'edit-open-size-boundary',
        why: '上限ちょうどのファイルも断る（実用的な大きさが開けなくなる）',
        file: 'v0/server.mjs',
        from: '        if (st.size > MAX_EDIT_BYTES) {',
        to: '        if (st.size >= MAX_EDIT_BYTES) {   /* 変異: 境界を含めて断る */',
        gone: 'if (st.size > MAX_EDIT_BYTES) {',
        pattern: '512KB を超える中身',
    },
    {
        name: 'write-path-validation',
        why: 'パスの形の検証を外す（`..` / 絶対パス / 先頭 `-` / NUL / pathspec magic が通る）',
        file: 'v0/server.mjs',
        from: '    if (!isSafeRepoPath(rel)) {',
        to: '    if (false) {',
        gone: 'if (!isSafeRepoPath(rel)) {',
        pattern: 'write: ../ と絶対パス',
    },
    {
        name: 'write-tracked-check',
        why: 'git の追跡下かを見ない（未追跡の .env を読み書きできる）',
        file: 'v0/server.mjs',
        from: '    if (ls.code !== 0 || !splitZ(ls.stdout).map(p => toNFC(p)).includes(rel)) {',
        to: '    if (false) {',
        gone: 'ls.code !== 0 ||',
        pattern: 'write: 未追跡ファイル',
    },
    {
        name: 'write-optimistic-lock',
        why: '楽観ロックを外す（別のエージェントが書いた内容を黙って上書きする）',
        file: 'v0/server.mjs',
        from: '                if (baseOid !== t.info.oid) {',
        to: '                if (false) {',
        gone: 'if (baseOid !== t.info.oid) {',
        pattern: 'write: 並行書き換え',
    },
    {
        name: 'write-eol-preserve',
        why: '改行コードと BOM を保たない（保存するたびに全行が変更になり、'
            + '並行して動いている別のエージェントと必ず衝突する）',
        file: 'v0/writefile.mjs',
        from: `    const out = eol === 'crlf'
        ? lf.replace(/\\n/g, '\\r\\n')
        : eol === 'cr' ? lf.replace(/\\n/g, '\\r') : lf;`,
        to: '    const out = lf;',
        gone: "eol === 'crlf'",
        pattern: 'write: CRLF と BOM',
    },
    {
        name: 'write-audit-no-content',
        why: '監査ログに書いた中身を残す（記録が read 権限からの秘密の持ち出し口になる）',
        file: 'v0/server.mjs',
        // ⚠️ 記録に `repo` を載せるようになったので字面が変わった（--dry で検出）
        from: `                    event: 'write', repo, worktree: t.wt.path, path: t.rel,
                    bytes: next.length, eol: t.info.eol, bom: t.info.bom,`,
        to: `                    event: 'write', repo, worktree: t.wt.path, path: t.rel, text,
                    bytes: next.length, eol: t.info.eol, bom: t.info.bom,`,
        gone: "event: 'write', repo, worktree: t.wt.path, path: t.rel,\n",
        pattern: 'write: 監査に残すが',
    },
    {
        name: 'write-symlink-containment',
        why: 'symlink と realpath 包含の検査を外す'
            + '（追跡された symlink 経由でリポジトリ外のファイルを読み書きできる）',
        file: 'v0/server.mjs',
        from: `    if (!containsPath(wt.path, abs)) {
        denyJson(res, 400, \`実体が worktree の外を指しています: \${rel}\`);
        return null;
    }`,
        to: '    /* 変異: 実体が worktree の中かを見ない */',
        // ⚠️ 同じ守りが3段（realpath 包含 / lstat / O_NOFOLLOW）あるので束ねて外す。
        //    1段だけ外すと `open` が ELOOP で落ちて別の理由の 409 になり、
        //    **「リポジトリ外が読めた」という本当の危険を測れない**。
        also: [
            { from: '    if (lst.isSymbolicLink()) {', to: '    if (false) {' },
            {
                from: '    const flags = (forWrite ? FS.O_RDWR : FS.O_RDONLY) | (FS.O_NOFOLLOW ?? 0);',
                to: '    const flags = forWrite ? FS.O_RDWR : FS.O_RDONLY;',
            },
        ],
        // ⚠️ Windows では symlink を作れない（EPERM）ので測れない。
        //    テスト側も t.skip() で「測れていない」と出す。ubuntu / macOS CI が測る。
        platforms: ['linux', 'darwin'],
        gone: 'if (!containsPath(wt.path, abs)) {',
        pattern: 'write: シンボリックリンク',
    },
    {
        name: 'write-tracked-check-converts-content',
        why: '追跡確認に「内容を変換する」git 呼び出しを足す'
            + '（`.gitattributes` の clean filter = リポジトリ設定の任意コマンドが起動する）',
        // 🚨 これは**足す**変異。守りは「変換を伴うコマンドを使わないこと」なので、
        //    外すべき行が無い。代わりに、その約束を書いたコメントを消して
        //    `git diff`（clean filter を通す）を1回足す。
        file: 'v0/server.mjs',
        from: `    // 🔒 **内容を変換しない git コマンドだけを使う。** \`status\` / \`diff\` / \`add\` は
    //    作業ツリーと index の中身を比べるので **\`.gitattributes\` の clean filter
    //    （= リポジトリ設定の任意コマンド）を起動する**（8回目のレビューの BLOCKING）。
    //    \`ls-files\` は index を読むだけで content conversion を伴わない。
    //    ここに1つ変換を伴う呼び出しを足すと、この経路が capability を1段上げる。
    let ls;
    try {`,
        to: `    let ls;
    try {
        await git(['diff', '--quiet', '--', rel], { cwd: wt.path, allowExit: [0, 1] });`,
        gone: '内容を変換しない git コマンドだけを使う',
        pattern: 'write: 編集の経路',
    },
    {
        name: 'editor-key-gate',
        why: '編集の入口を `canMutate`（生の鍵）ではなく `token` の有無で出す'
            + '（案内の URL に載る読み取り用の鍵でも真になるので、'
            + '押すと必ず 403 の「編集」をスマホに出す）',
        // 🚨 実ブラウザで測る。`--require-auth` + 鍵を捨てて読み込み直した状態で、
        //    編集ボタンが出ていないことを見ている（字面では測れない）。
        file: 'v0/app.html',
        from: '      if (session.canMutate) {\n        const eb = el(\'button\', null, \'編集\');',
        to: '      if (session.token) {\n        const eb = el(\'button\', null, \'編集\');',
        gone: "if (session.canMutate) {\n        const eb",
        script: 'v0/render-check.mjs',
    },
    {
        name: 'editor-pane-rebuild',
        why: '自動更新で編集中のペインを作り直す（打っている途中の内容が消える）',
        // 🚨 **実ブラウザで測る（`script`）。** 字面の検査では
        //    「行を残したまま到達不能にする変更」が見えないので、
        //    textarea の同一性・値・件数を実際に測っている検査を走らせる。
        file: 'v0/app.html',
        from: '    if (obj.editing) continue;',
        to: '    /* 変異: 編集中でも作り直す */',
        gone: 'if (obj.editing) continue;',
        script: 'v0/render-check.mjs',
    },
    /* ---- 複数リポジトリ（`--repo` を複数回） ----
     *
     * 🔒 ここの守りの本体は「**読める範囲は起動時に固定する**」。
     *    `?repo=` は登録済み一覧との `samePath()` 照合しか通さない。
     *    照合を外すと、トークンが1本漏れた時点で
     *    **マシン上の任意の git リポジトリが読める**（読み取りだけでなく
     *    `--allow-exec` があればその中でコマンドも動く）。
     */
    {
        name: 'repo-registry-gate',
        why: '登録済み一覧との照合を外す（未登録の任意のリポジトリが読め、'
            + '--allow-exec ならその中でコマンドも動く = 実行の範囲が広がる）',
        file: 'v0/server.mjs',
        from: `    const hit = opts.repos.find(r => samePath(r, want));
    if (!hit) return { error: \`登録されていないリポジトリです: \${want}\` };
    return { repo: hit };`,
        to: '    return { repo: want };   /* 変異: 登録済みかを見ない */',
        gone: '登録されていないリポジトリです',
        pattern: '未登録のパスは 400',
    },
    {
        name: 'repo-registry-samepath',
        why: '照合を === にする（区切り文字・8.3 短縮名・symlink で外れ、'
            + '正しく登録したリポジトリが表記の違いだけで 400 になる）',
        file: 'v0/server.mjs',
        from: '    const hit = opts.repos.find(r => samePath(r, want));',
        to: '    const hit = opts.repos.find(r => r === want);',
        gone: 'samePath(r, want)',
        pattern: '表記が違っても登録済みなら通る',
    },
    {
        name: 'repo-cache-per-repo',
        why: 'TTL キャッシュをリポジトリ間で共有する'
            + '（A を読んだ直後に B を読むと **A の payload が B として返る**）',
        file: 'v0/server.mjs',
        from: '    const hit = cachedByRepo.get(repo);',
        to: '    const hit = [...cachedByRepo.values()][0];   /* 変異: どのリポジトリのでも返す */',
        gone: 'cachedByRepo.get(repo)',
        pattern: 'TTL キャッシュがリポジトリごとに分かれる',
    },
    {
        name: 'repo-inflight-per-repo',
        why: '同時要求の合流をリポジトリ間で共有する'
            + '（A の収集中に来た B の要求が A の Promise に合流して A の payload を受け取る）',
        file: 'v0/server.mjs',
        from: '    const running = inFlightByRepo.get(repo);',
        to: '    const running = [...inFlightByRepo.values()][0];   /* 変異: どれでも合流させる */',
        gone: 'inFlightByRepo.get(repo)',
        pattern: '同時要求の合流もリポジトリごと',
    },
    {
        name: 'repo-worktree-allowlist',
        why: 'worktree の allowlist を全リポジトリの合併に対して引く'
            + '（A を選んでいるのに B の worktree でコマンドが動く = ?repo= の意味が消える）',
        file: 'v0/server.mjs',
        // ⚠️ インデントまで含めて一意にする（checkout 側に同じ式がある）
        from: '                const worktrees = await listWorktrees(repo);',
        to: '                const worktrees = (await Promise.all('
            + 'opts.repos.map(r0 => listWorktrees(r0)))).flat();',
        gone: '                const worktrees = await listWorktrees(repo);',
        pattern: 'worktree の allowlist は',
    },
    {
        name: 'repo-label-collision',
        why: 'basename が衝突しても畳まない'
            + '（同名のリポジトリ2本が同じ表示名になり、どちらを操作しているか分からない）',
        file: 'v0/dirlabel.mjs',
        from: '    return base.map((b, i) => ((count.get(b) ?? 0) > 1 ? list[i] : b));',
        to: '    return base;   /* 変異: 衝突を見ない */',
        gone: '(count.get(b) ?? 0) > 1 ? list[i] : b',
        pattern: 'basename が衝突したらフルパスを出す',
    },
    {
        name: 'repo-startup-fail-closed',
        why: '開けないリポジトリを黙って落として起動する'
            + '（「登録したつもりの1本が一覧に無い」を起動ログを読むまで気付けない）',
        file: 'v0/server.mjs',
        from: "            console.error('      node v0/server.mjs --repo C:/path/to/repo"
            + " --repo D:/other/repo\\n');\n            process.exit(1);",
        to: '            continue;   /* 変異: 黙って落とす */',
        gone: '--repo D:/other/repo',
        pattern: '開けないリポジトリを1本でも渡したら起動しない',
    },
    {
        name: 'repo-dedupe',
        why: '同じ場所を2回渡したときに重複を潰さない'
            + '（セレクトに2行出て、キャッシュも2重になる）',
        file: 'v0/server.mjs',
        from: '            if (normalized.some(r => samePath(r, resolved))) {',
        to: '            if (false) {',
        gone: 'normalized.some(r => samePath(r, resolved))',
        pattern: '同じ場所を2回渡したら1本にまとめる',
    },
    {
        name: 'serve-repos-forward',
        why: '複数の --repo を1本目だけサーバに渡す'
            + '（起動口で2本指定したのに1本しか見えない）',
        file: 'scripts/serveargs.mjs',
        from: `    const args = [server];
    // 🔒 読める範囲。**1本目が既定**なので順序を保つ
    for (const r of repos) args.push('--repo', r);`,
        to: "    const args = [server];\n    args.push('--repo', repos[0]);",
        // ⚠️ `for (const r of repos) …` は autostartServeArgs にも同じ字面であるので、
        //    serverArgs 側だけに在るコメント行を目印にする（両方に当たると
        //    「書き換えが効いていない」で SKIP に落ちて守りが未検証になる）
        gone: '    // 🔒 読める範囲。**1本目が既定**なので順序を保つ',
        pattern: '複数の --repo をサーバに全部渡す',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'autostart-repos-forward',
        why: '自動起動の登録に --repo を1本しか引き継がない'
            + '（**ログオン後だけ1本に戻る**。手元では絶対に気付けない #45 と同型）',
        file: 'scripts/serveargs.mjs',
        from: "    const args = [];\n    for (const r of repos) args.push('--repo', r);",
        to: "    const args = [];\n    args.push('--repo', repos[0]);",
        gone: "    const args = [];\n    for (const r of repos)",
        pattern: '自動起動の登録に --repo を全部引き継ぐ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'repos-of-all-values',
        why: 'コマンドラインから --repo を1本目しか読まない'
            + '（2本要求した人に「既に動いています」と答えて、2本目が見えないことを黙る）',
        file: 'scripts/winargs.mjs',
        from: '    const re = /--repo\\s+(?:"([^"]*)"|(\\S+))/g;',
        to: '    const re = /--repo\\s+(?:"([^"]*)"|(\\S+))/;   /* 変異: g を外す = 1本目だけ */',
        gone: '(\\S+))/g;',
        pattern: 'reposOf: --repo を全部取る',
        testFile: 'scripts/winargs.test.mjs',
    },
    {
        name: 'config-diff-repos',
        why: '「既に動いています」で要求したリポジトリの差分を見ない'
            + '（--repo A --repo B を打った人に、B が見えないことを黙って exit 0 する。'
            + '--timeout を集合に入れていなかったのと同型の穴）',
        file: 'scripts/serveargs.mjs',
        from: '    for (const r of (Array.isArray(repos) ? repos : [])) {',
        to: '    for (const r of []) {   /* 変異: リポジトリの差分を見ない */',
        gone: 'Array.isArray(repos) ? repos : []',
        pattern: 'configDiff は要求したリポジトリ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'running-config-repos-quoted',
        why: 'コマンド行の --repo を空白で切って読む'
            + '（空白入りのパスが途中で切れ、見えているのに「見えていない」と誤報して'
            + '毎回入れ直しを要求する）',
        file: 'scripts/serveargs.mjs',
        from: '    return { caps: runningCaps(cmd), hosts, execTimeout, repos: reposOf(cmd) };',
        to: '    return { caps: runningCaps(cmd), hosts, execTimeout,\n'
            + "        repos: (String(cmd ?? '').split(/\\s+/)\n"
            + "            .map((t, i, a) => (t === '--repo' ? a[i + 1] : null)).filter(Boolean)) };",
        gone: 'repos: reposOf(cmd)',
        pattern: 'configDiff は空白入りのパスでも',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 🚨 CSS の規則そのものにも変異を当てる。書き間違いでブラウザが規則を
        //    黙って捨てても、構文チェックにも `node --check` にも掛からない
        //    （実際にコメントの `*/` を余らせて `:has()` の規則を1つ落とした）。
        name: 'repo-select-swaps-path',
        why: '狭い画面でセレクトとパスの入れ替えをやめる'
            + '（トップバーは伸びも折り返しもしないので、後ろのボタンが枠外に出る）',
        file: 'v0/app.html',
        from: '    .topbar:has(select:not([hidden])) #repo { display: none; }',
        to: '    /* 変異: パスを落とさない */',
        gone: '.topbar:has(select:not([hidden])) #repo',
        script: 'v0/layout-check.mjs',
    },
    {
        name: 'repo-select-not-rebuilt',
        why: '自動更新でリポジトリのセレクトを作り直す'
            + '（選択が既定に戻り、見ている画面と操作の対象がずれる。'
            + '字面の検査では完全に見えないので実ブラウザで測る）',
        file: 'v0/app.html',
        // 自動更新のたびにセレクトを作り直す形にする（`load()` の中で組む変更と等価）
        from: "$('#refresh').addEventListener('click', () => load(true));",
        to: "$('#refresh').addEventListener('click', () => {\n"
            + "  const s = $('#reposel');\n"
            + "  if (!s.hidden) {\n"
            + "    const opts2 = [...s.options].map(o => [o.value, o.textContent]);\n"
            + "    s.replaceChildren();\n"
            + "    for (const [v, t] of opts2) {\n"
            + "      const o = document.createElement('option');\n"
            + "      o.value = v; o.textContent = t; s.append(o);\n"
            + "    }\n"
            + "  }\n"
            + "  load(true);\n"
            + '});   /* 変異: 自動更新でセレクトを作り直す */',
        gone: "$('#refresh').addEventListener('click', () => load(true));",
        script: 'v0/render-check.mjs',
    },
    {
        name: 'repo-select-change-reloads',
        why: 'セレクトを切り替えても state を取り直さない'
            + '（見ている画面が別のリポジトリのまま。操作だけが切り替わる = 最悪の形）',
        file: 'v0/app.html',
        from: '          currentRepo = sel.value;',
        to: '          /* 変異: 選択を反映しない */',
        gone: 'currentRepo = sel.value;',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'repo-select-hidden-when-single',
        why: 'リポジトリが1本でもセレクトを描く'
            + '（選ぶものが無い操作が出る。狭い画面では他の操作を枠外へ押し出す）',
        file: 'v0/app.html',
        from: '      if (repos.length > 1) {',
        to: '      if (repos.length > 0) {',
        gone: 'repos.length > 1',
        // 🚨 **2本で起動している検査では絶対に落ちない**（最初 smoke の
        //    「一覧は1件」に当てて SURVIVED した。あれは API を見ているだけで
        //    UI を1度も描いていない）。**1本構成を実ブラウザで描いて数える**
        //    パスを layout-check に足して、そこで測る。
        script: 'v0/layout-check.mjs',
    },
];

const args = process.argv.slice(2);
if (args.includes('--list')) {
    for (const m of MUTANTS) console.log(`${m.name.padEnd(28)} ${m.why}`);
    process.exit(0);
}
// ⚠️ `--shard 2/4` の値は名前の指定ではない。除かないと
//    「一致する変異がありません: 2/4」になる（実際に踏んだ）
// 🚨 **`indexOf` が -1 のときに +1 して 0 にしてはいけない。** `--shard` が無いと
//    `i !== 0` が最初の名前を落とし、**指定した変異が黙って走らなかった**
//    （3件指定して2件しか出ず、走っていない1件を「確認済み」と読みかけた）。
const shardIdx = args.indexOf('--shard');
const shardValueIdx = shardIdx === -1 ? -1 : shardIdx + 1;
const want = args.filter((a, i) => !a.startsWith('--') && i !== shardValueIdx);
// 🚨 **指定した名前が1つでも見つからなければ止める。** 黙って少ない件数を走らせると、
//    走っていない変異を「確認済み」と読んでしまう（実際にそう読みかけた）。
{
    const unknown = want.filter(w => !MUTANTS.some(m => m.name === w));
    if (unknown.length) {
        console.error(`✖ そんな名前の変異はありません: ${unknown.join(', ')}`);
        console.error('  一覧: node scripts/mutate.mjs --list');
        process.exit(1);
    }
}
let targets = want.length ? MUTANTS.filter(m => want.includes(m.name)) : MUTANTS;

/**
 * `--shard i/n` で分割する。CI を並列に回すため。
 *
 * 🚨 **時間が伸びると CI で打ち切られ、結果が「不明」になる。**
 *    変異が 62 → 96 件に増えたら Linux の job（上限15分）が cancelled になり、
 *    **突然変異の結果が出ないまま**「他は success」の表示になった。
 *    打ち切られたものを緑と読まないために、分割して各シャードを短く保つ。
 * ⚠️ **分割したことを必ず出す。** 出さないと部分実行を全体と読み違える。
 */
let shard = null;
{
    const i = args.findIndex(a => a === '--shard');
    const raw = i !== -1 ? args[i + 1] : args.find(a => a.startsWith('--shard='))?.split('=')[1];
    if (raw !== undefined) {
        const m = /^(\d+)\/(\d+)$/.exec(String(raw));
        if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
            console.error(`--shard は i/n の形で指定してください（受け取った値: ${raw}）`);
            process.exit(1);
        }
        shard = { index: Number(m[1]), total: Number(m[2]) };
        // 費用が偏らないよう round-robin で配る（render 系は1件60秒、unit 系は2秒）
        targets = targets.filter((_, k) => k % shard.total === shard.index - 1);
    }
}
if (!targets.length) {
    console.error(want.length
        ? `一致する変異がありません: ${want.join(', ')}`
        : `シャード ${shard?.index}/${shard?.total} に割り当てられた変異がありません`);
    process.exit(1);
}
if (shard) {
    console.log(`シャード ${shard.index}/${shard.total}: `
        + `${targets.length} 件（全 ${MUTANTS.length} 件のうち）を走らせます`);
}

/**
 * 🚨 **`--dry`: 字面のずれ（STALE）だけをテスト無しで洗い出す。**
 *
 * 全件を走らせると数十分かかるので、**リファクタの直後**にこれを回す。
 * STALE は「守りを外せていない」= 守りが未検証のまま静かに続く状態なので、
 * 見つけるのが早いほどよい（`--shard` の tail だけを読むと**どれがずれたのか
 * 分からない**という形で実際に困った）。
 */
if (args.includes('--dry')) {
    let bad = 0;
    for (const m of targets) {
        const problems = [];
        let src;
        try { src = readFileSync(m.file, 'utf8'); } catch { problems.push(`${m.file} が読めない`); }
        if (src !== undefined) {
            const hits = src.split(m.from).length - 1;
            if (hits === 0) problems.push('from がソースに無い');
            // ⚠️ 複数一致は「どこを書き換えたか分からない」= 測っている対象が不定
            else if (hits > 1) problems.push(`from が ${hits} 箇所に一致する`);
            else {
                let mutated = src.replace(m.from, m.to);
                for (const extra of m.also ?? []) {
                    if (!mutated.includes(extra.from)) {
                        problems.push(`also の from が無い: ${extra.from.slice(0, 40)}`);
                        continue;
                    }
                    mutated = mutated.replace(extra.from, extra.to);
                }
                if (mutated.includes(m.gone)) problems.push('書き換え後も gone が残る（判定が甘い）');
            }
        }
        if (problems.length) {
            bad++;
            console.log(`✖ ${m.name.padEnd(28)} ${problems.join(' / ')}`);
        }
    }
    console.log(bad
        ? `✖ ${bad} 件がソースとずれている（守りは1つも検証されていない）`
        : `✔ ${targets.length} 件すべて字面は一致（実際に落ちるかはテストを走らせて確認）`);
    process.exit(bad ? 1 : 0);
}

function runTest(m) {
    return new Promise(resolve => {
        // `script` を持つ変異は `node --test` ではなく検査スクリプトを直接走らせる。
        // ⚠️ **layout / render の検査もここに掛けられるようにするため。**
        //    これが無いと「実ブラウザで測る検査」だけが変異テストの外に残り、
        //    予算を守っているコードを外しても誰も気付かない状態になる。
        const argv = m.script
            ? [m.script]
            : ['--test', `--test-name-pattern=${m.pattern}`, m.testFile ?? 'v0/smoke.test.mjs'];
        const p = spawn(process.execPath, argv,
            { cwd: ROOT, shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        let timedOut = false;
        const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 300_000);
        // 🚨 **'error' を必ず拾う。** ChildProcess の 'error' に listener が無いと
        //    Node は uncaught exception として**プロセスを即死させる**。
        //    そうなると下の finally が走らず、**書き換えたソースが復元されないまま
        //    `*.mutate-bak` が残る**。実際に起き、その bak が `git add -A` で
        //    コミットに混入した（Windows で多数プロセスを起動している最中の
        //    一時的な spawn 失敗が引き金）。
        p.on('error', err => {
            clearTimeout(t);
            resolve({ code: -1, out: `${out}\n[spawn 失敗] ${err.message}`, timedOut });
        });
        p.on('close', code => { clearTimeout(t); resolve({ code, out, timedOut }); });
    });
}

/**
 * 書き換えたソースを必ず戻すための最後の砦。
 *
 * ⚠️ `finally` は**throw には効くがプロセスの即死には効かない**。
 *    シグナルと uncaught をここで拾って復元する。
 */
const pending = new Map();   // file -> bak

/**
 * 結果。**handlers より前に宣言する。**
 * 🚨 途中で落ちると要約が1行も出ず、**結果が不明なのを緑と読める**状態になる
 *    （適用側の共有違反でクラッシュして実際にそうなった）。落ちても必ず告知する。
 */
const results = [];
function announcePartial(why) {
    console.error(`
✖ 途中で終わりました（${why}）。${results.length} 件まで実行。`
        + '**結果は不明です**（全件走っていません）。');
}

/**
 * 控えから戻す。
 *
 * ⚠️ **Windows では一時的に失敗する。** テストが終わった直後は
 *    まだ別プロセスがファイルを開いていることがあり、`copyFileSync` が
 *    `UNKNOWN (-4094)`（共有違反）で落ちる。**1回で諦めると
 *    変異が残ったままになる**ので短い間隔で数回試す（実際に踏んだ）。
 */
/**
 * 書き換えを**適用する**側も retry する。
 *
 * ⚠️ 復元だけ retry していたので、**適用が共有違反で落ちて全件が中断**した
 *    （`writeFileSync ... UNKNOWN (-4094)` on `v0/git.mjs`。砦が復元したので
 *     ソースは無傷だったが、**要約が出ないまま終わった = 結果が不明**になった）。
 *    Windows では直前のテストがまだファイルを開いていることがある。
 */
function writeFileRetry(file, text) {
    let last = null;
    for (let i = 0; i < 20; i++) {
        try { writeFileSync(file, text, 'utf8'); return true; } catch (e) {
            last = e;
            const until = Date.now() + 100;
            while (Date.now() < until) { /* 短いスピン */ }
        }
    }
    console.error(`✖ ${file} に書けません: ${last?.message}`);
    return false;
}

function restoreFile(file, bak) {
    let last = null;
    for (let i = 0; i < 20; i++) {
        try {
            copyFileSync(bak, file);
            unlinkSync(bak);
            return true;
        } catch (e) {
            last = e;
            // 同期的に少し待つ（ここでイベントループを回すと復元が遅れる）
            const until = Date.now() + 100;
            while (Date.now() < until) { /* 短いスピン */ }
        }
    }
    console.error(`✖ ${file} を復元できません: ${last?.message}`);
    console.error(`   手で戻してください: copy "${bak}" "${file}"`);
    return false;
}

function restoreAll(why) {
    for (const [file, bak] of pending) {
        if (!existsSync(bak)) continue;
        if (restoreFile(file, bak)) console.error(`⚠ ${why}: ${file} を復元しました`);
    }
    pending.clear();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreAll(`シグナル ${sig}`); announcePartial(sig); process.exit(130); });
}
process.on('uncaughtException', e => {
    restoreAll('uncaught');
    console.error(e);
    announcePartial('uncaught');
    process.exit(1);
});
process.on('unhandledRejection', e => {
    restoreAll('unhandledRejection');
    console.error(e);
    announcePartial('unhandledRejection');
    process.exit(1);
});

// 🚨 前回の実行が残した書き換えを引きずらない。
//    残骸がある状態で走らせると、変異の上に変異を重ねることになる。
//
// ⚠️ **SIGKILL では `finally` もシグナルハンドラも走らない。** 実際に踏んだ:
//    シェルの上限（2分）で SIGKILL され、`v0/app.html` が変異したまま残った。
//    しかも `*.mutate-bak` は `.gitignore` にあるので `git status` には出ない
//    （変異したソース自体は出るので、**`git add -A` の前に読む**のが最後の砦）。
//    復元を手順ではなく**仕組み**にする: `--restore` で bak から戻す。
{
    const stale = [...new Set(MUTANTS.map(m => `${m.file}.mutate-bak`))].filter(existsSync);
    if (args.includes('--restore')) {
        if (!stale.length) { console.log('復元するものはありません'); process.exit(0); }
        let ok = true;
        for (const b of stale) {
            const file = b.replace(/\.mutate-bak$/, '');
            if (restoreFile(file, b)) console.log(`✔ 復元しました: ${file}`);
            else ok = false;
        }
        process.exit(ok ? 0 : 1);
    }
    if (stale.length) {
        console.error('\n✖ 前回の実行が残した書き換えがあります:');
        for (const b of stale) console.error(`    ${b} → ${b.replace(/\.mutate-bak$/, '')}`);
        console.error('\n  ソースが変異したままです（SIGKILL されると finally が走りません）。');
        console.error('  bak から戻す:');
        console.error('      node scripts/mutate.mjs --restore\n');
        process.exit(1);
    }
}

for (const m of targets) {
    if (m.platforms && !m.platforms.includes(process.platform)) {
        results.push({ m, status: 'SKIP', note: `このプラットフォームでは通らない経路（${m.platforms.join('/')} 用）` });
        continue;
    }
    const bak = `${m.file}.mutate-bak`;
    let applied = false;
    try {
        const src = readFileSync(m.file, 'utf8');
        if (!src.includes(m.from)) {
            // 🚨 **これは失敗。** 字面がずれた変異は「守りを外せていない」だけで、
            //    守りが検証されない状態が静かに続く（実際に `worktree-allowlist` が
            //    CI で SKIP のまま残り、`samePath` の変異も同じ形で落ちていた）。
            //    プラットフォーム外の SKIP とは意味が違うので**分けて失敗にする**。
            results.push({ m, status: 'STALE', note: '書き換え対象が見つからない（コードが変わった）' });
            continue;
        }
        copyFileSync(m.file, bak);
        applied = true;
        pending.set(m.file, bak);
        // ⚠️ `also` は「同じ守りが二重になっていて、片方ずつでは測れない」場合に
        //    複数箇所を同時に外すための追加。**単独で落ちない = テストの穴**とは
        //    限らないので、二重の守りは束ねて測る（実際に exec の終端で必要になった）。
        let mutated = src.replace(m.from, m.to);
        for (const extra of m.also ?? []) {
            if (!mutated.includes(extra.from)) {
                results.push({ m, status: 'STALE', note: `also の対象が見つからない: ${extra.from.slice(0, 40)}` });
                mutated = null;
                break;
            }
            mutated = mutated.replace(extra.from, extra.to);
        }
        if (mutated === null) continue;
        // ⚠️ ここで落ちると全件が中断して**結果が不明**になる（実際に踏んだ）
        if (!writeFileRetry(m.file, mutated)) {
            results.push({ m, status: 'STALE', note: '書き換えを適用できなかった（ファイルが掴まれている）' });
            continue;
        }
        if (readFileSync(m.file, 'utf8').includes(m.gone)) {
            results.push({ m, status: 'STALE', note: '書き換えが効いていない（gone の判定が甘い）' });
            continue;
        }
        const r = await runTest(m);
        if (m.script) {
            // 検査スクリプトは「ブラウザが無ければスキップ」を自分で出す。
            // 🚨 **それを緑と読まない。** 測れていないことを SKIP として出す。
            if (/skipped/.test(r.out)) {
                results.push({ m, status: 'SKIP', note: `${m.script} が測れなかった（ブラウザ無し）` });
                continue;
            }
            if (r.timedOut) {
                results.push({
                    m, status: 'HUNG',
                    note: `${m.script} が上限まで返らなかった。`
                        + '守りを外すと止まらなくなる = 落ちる形になっていない',
                });
                continue;
            }
            const killed = r.code !== 0;
            results.push({
                m,
                status: killed ? 'KILLED' : (m.defensive ? 'DEFENSIVE' : 'SURVIVED'),
                note: killed ? ''
                    : (m.defensive ?? `${m.script} が落ちなかった = この守りは検証されていない`),
            });
            continue;
        }
        // ⚠️ `ℹ tests N` で判定してはいけない。`--test-name-pattern` に外れたテストも
        //    N に数えられて `skipped` になるだけなので、**1件も走っていないのに
        //    「落ちなかった → SURVIVED」と誤報する**（pattern をテスト名ではなく
        //    assert のメッセージに書いていて、実際にこれで誤報が出た）。
        //    実際に走った本数は pass + fail で数える。
        const n = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.out)?.[1] ?? 0);
        if (n('pass') + n('fail') === 0) {
            // 🚨 **「走らなかった」には2つの原因があり、意味が正反対。**
            //    (a) pattern がテスト名に一致していない → 検査の設定ミス（SKIP）
            //    (b) **テストがハングして SIGKILL された** → 守りを外したら
            //        止まらなくなった = **変異は効いている**。これを SKIP にすると
            //        ツール自身が「SKIP を緑と読まない」という規則を破り、
            //        しかも「テスト名を直せ」という**無関係な修正へ誘導する**（#32）。
            //    要約が出ていない（= 途中で殺された）なら (b) として扱う。
            const summarized = /^ℹ tests \d+/m.test(r.out);
            if (!summarized || r.timedOut) {
                results.push({
                    m, status: 'HUNG',
                    note: 'テストがハングした（要約が出ていない）。'
                        + '守りを外すと止まらなくなる = 変異は効いているが、'
                        + '**落ちる形になっていない**。上限を付けて失敗として観測できるようにすること',
                });
                continue;
            }
            results.push({
                m, status: 'STALE',
                note: `pattern に一致するテストが無い（テスト名に含まれる文字列を書く）: ${m.pattern}`,
            });
            continue;
        }
        const killed = r.code !== 0;
        results.push({
            m,
            status: killed ? 'KILLED' : (m.defensive ? 'DEFENSIVE' : 'SURVIVED'),
            note: killed ? ''
                : (m.defensive ?? 'テストが落ちなかった = この守りは検証されていない'),
        });
    } finally {
        if (applied && existsSync(bak)) restoreFile(m.file, bak);
        pending.delete(m.file);
    }
}

console.log('');
let bad = 0;
for (const r of results) {
    const mark = { KILLED: '✔', SURVIVED: '✖', HUNG: '✖', STALE: '✖', DEFENSIVE: '◦', SKIP: '–' }[r.status];
    // 冗長な防御とプラットフォーム外は失敗にしない（記録として残す）。
    // 🚨 **HUNG も失敗**。ハングは「落ちない検査」なので緑にしてはいけない（#32）
    if (r.status === 'SURVIVED' || r.status === 'HUNG' || r.status === 'STALE') bad++;
    console.log(`${mark} ${r.m.name.padEnd(28)} ${r.status.padEnd(9)} ${r.note || r.m.why}`);
}
console.log('');
const k = results.filter(r => r.status === 'KILLED').length;
const d = results.filter(r => r.status === 'DEFENSIVE').length;
const sk = results.filter(r => r.status === 'SKIP').length;
const hung = results.filter(r => r.status === 'HUNG').length;
const stale = results.filter(r => r.status === 'STALE').length;
console.log(`${k} 件が期待通り落ちた / ${d} 件は冗長な防御（想定内）`
    + ` / ${sk} 件はスキップ${hung ? ` / ${hung} 件はハング` : ''}`
    + `${stale ? ` / ${stale} 件は字面がずれている` : ''}`
    // 🚨 部分実行を全体と読み違えないよう、必ず添える
    + (shard ? `（シャード ${shard.index}/${shard.total}。全 ${MUTANTS.length} 件の一部）` : ''));
if (bad) console.log('✖ = テストがその守りを検証できていない。テストを直すこと');
// 🚨 **字面がずれた変異は失敗。** 「守りを外せていない」だけなので、
//    守りが検証されない状態が静かに続く（CI で SKIP のまま残っていた）。
if (stale) {
    console.log(`✖ ${stale} 件は変異の from/gone/pattern がソースとずれている。`
        + '変異を直すこと（守りは1つも検証されていない）');
}
// ⚠️ SKIP も無害ではない。**検証されていない守り**なので数を必ず出す
if (sk) console.log(`– = ${sk} 件はこのプラットフォームでは通らない経路`);
// 🚨 終了時に残骸が無いことを確かめる。ここが残ると次回以降が汚染される。
{
    const left = [...new Set(MUTANTS.map(m => `${m.file}.mutate-bak`))].filter(existsSync);
    if (left.length) {
        console.error(`
✖ 書き換えの控えが残っています: ${left.join(', ')}`);
        console.error('  ソースが復元されていない可能性があります。git diff で確認してください。');
        bad++;
    }
}
process.exit(bad ? 1 : 0);
