# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MVReiha/mend-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MVReiha/mend-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in four
formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON tool calls — atomically: every file is changed or
nothing is. Lines are matched at three tiers (exact, trailing-whitespace
insensitive, fully trimmed with re-indentation), so edits land even when the
model's whitespace and indentation drifted.

Entry for the [Build mend bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on [make.fun](https://make.fun).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, which detects the format).
- `--check`: do everything but write — same output and exit code, no file
  created, changed or deleted.
- `--strict`: match lines exactly (tier 0 only).
- `PATCH`: the patch file, relative to the working directory; absent or `-`
  reads the patch from standard input.

Exit 0 lists the changed files (`A`/`D`/`M`/`R`) and `ok: <n> files`.
Exit 1 lists the failed edits and `failed: <k> of <n> edits` — and writes
nothing. Exit 2 reports a usage, missing-patch, format or parse error.

Node 22, standard library alone. `main.ts` is the CLI; `runner.ts` is the
kit's trial runner, kept as shipped.
