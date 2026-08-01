# NOTICE

kjp-edit is licensed under the MIT License (see `LICENSE`).

## Code adapted from other projects

### Microsoft Visual Studio Code — MIT

`v0/swimlanes.mjs` re-implements the swimlane (commit-DAG lane assignment)
algorithm from `src/vs/workbench/contrib/scm/browser/scmHistory.ts`.

    Copyright (c) 2015 - present Microsoft Corporation
    Licensed under the MIT License.

<https://github.com/microsoft/vscode>

## Planned dependencies not yet vendored

If this project later builds on Eclipse Theia, the following obligations apply
(see `docs/licensing.md`):

- Eclipse Theia (`@theia/*`) — `EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`,
  disjunctive. **The EPL-2.0 branch is elected.** Redistributing Theia in an
  installer requires an EPL-2.0 §3.1(a) statement that its source is available
  and how to obtain it, a copy of the EPL-2.0 (§3.2(b)), and preservation of
  its notices (§3.3). <https://github.com/eclipse-theia/theia>
- `remend` — Apache-2.0. Its npm tarball ships no LICENSE file, so the
  repository LICENSE text must be vendored here manually (Apache-2.0 §4(a)).
