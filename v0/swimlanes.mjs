// SPDX-License-Identifier: MIT
//
// スイムレーン（コミットDAGのレーン割当）。
// アルゴリズムは microsoft/vscode の
// src/vs/workbench/contrib/scm/browser/scmHistory.ts (MIT) の
// toISCMHistoryItemViewModelArray() を参考に再実装したもの。
//
//   Copyright (c) Microsoft Corporation. All rights reserved.
//   Licensed under the MIT License.
//
// 単一の前進パス。各コミットについて:
//   1. lane = そのコミットを予約している input レーンの位置。無ければ空きスロット
//   2. output = input を歩き、自分のレーンは第一親に置き換え、
//      同じコミットを指す他のレーン（合流）は畳み、残りはそのまま
//   3. 第二親以降（マージ）を新レーンとして追加
//
// ⚠️ 実装上つまずいた2点（回帰テスト参照）:
//   - output のレーンは ID で重複排除しないと、同一コミットに2本開いたまま
//     1本しか消費されず残り続ける（16コミットで13レーンになった）
//   - しかし lane の割当まで畳んではいけない。兄弟ブランチが同じレーンになる
//     （agent-a と agent-b が両方 lane 0 になった）。
//     「どこに点を描くか」と「下にどのレーンが続くか」は別の概念。
//
// 既知の限界（VS Code と同じ）: 直線化パスもレーン圧縮も無いので密なマージ領域で線がうねる。
// 将来 pvigier の straight-branches に差し替える余地がある。

// 10色。パレットが5色だったので、エージェントが6本以上並ぶと
// 隣接レーンが同色になり区別できなかった（レビューで発覚）。
// nextColor() が「今開いているレーンで使われていない色」を選ぶのが本質的な修正で、
// パレット拡張はその選択肢を確保するためのもの。
export const LANE_COLORS = [
    '#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF',
    '#648FFF', '#FE6100', '#009E73', '#CC79A7', '#8C8C00',
];

/**
 * @param {{hash: string, parents: string[]}[]} commits 新しい順（--topo-order）
 * @returns {{hash: string, lane: number, color: string, firstParentLane: number,
 *            mergeParentLanes: number[],
 *            input: {id: string, color: string}[],
 *            output: {id: string, color: string}[]}[]}
 */
export function computeSwimlanes(commits) {
    /** @type {{id: string, color: string}[]} */
    let input = [];
    let colorIndex = -1;

    /**
     * 今使われていない色を選ぶ。全色使用中なら順送りにフォールバックする。
     * @param {Set<string>} avoid 現在開いているレーンの色
     */
    const nextColor = avoid => {
        for (let k = 1; k <= LANE_COLORS.length; k++) {
            const idx = (colorIndex + k) % LANE_COLORS.length;
            if (!avoid.has(LANE_COLORS[idx])) {
                colorIndex = idx;
                return LANE_COLORS[idx];
            }
        }
        colorIndex = (colorIndex + 1) % LANE_COLORS.length;
        return LANE_COLORS[colorIndex];
    };

    const rows = [];

    for (const commit of commits) {
        // 2. 下に続くレーンを組む（ID で重複排除する）
        const output = [];
        const push = node => {
            const at = output.findIndex(o => o.id === node.id);
            if (at !== -1) return at;
            output.push(node);
            return output.length - 1;
        };
        /** input と output の両方から、既に使われている色を集める */
        const openColors = () => new Set([
            ...input.map(n => n.color),
            ...output.map(n => n.color),
        ]);

        // 1. このコミットが座るレーン
        let lane = input.findIndex(n => n.id === commit.hash);
        let color;
        if (lane === -1) {
            // 表示範囲での新しい枝の先頭。input と衝突しない空きスロットへ
            lane = input.length;
            color = nextColor(openColors());
        } else {
            color = input[lane].color;
        }

        let firstParentLane = -1;
        for (let i = 0; i < input.length; i++) {
            const node = input[i];
            if (node.id === commit.hash) {
                // 自分のレーン（および自分に合流する他のレーン）
                if (i === lane && commit.parents.length > 0) {
                    firstParentLane = push({ id: commit.parents[0], color });
                }
                continue;
            }
            push({ id: node.id, color: node.color });
        }
        // 新しい枝の先頭だった場合はここで第一親を開く
        if (firstParentLane === -1 && commit.parents.length > 0) {
            firstParentLane = push({ id: commit.parents[0], color });
        }

        // 3. 第二親以降（マージ）。
        // どの output レーンに降りたかを記録する。これが無いと UI は
        // 第一親への線しか引けず、第二親のレーンがマージ行から
        // 何にも繋がらずに突然現れていた（レビューで発覚）。
        const mergeParentLanes = [];
        for (let i = 1; i < commit.parents.length; i++) {
            const existing = output.findIndex(o => o.id === commit.parents[i]);
            // 既に開いているレーンに合流する場合は色を消費しない
            const at = existing !== -1
                ? existing
                : push({ id: commit.parents[i], color: nextColor(openColors()) });
            mergeParentLanes.push(at);
        }

        rows.push({
            hash: commit.hash,
            lane,
            color,
            firstParentLane,   // 点から下へ引く線の着地レーン。-1 なら root
            mergeParentLanes,  // 第二親以降の着地レーン（マージのフォーク線用）
            input,
            output,
        });
        input = output;
    }

    return rows;
}

export const SWIMLANE_WIDTH = 11;
export const ROW_HEIGHT = 24;
