# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NozartXE/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NozartXE/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files. It reads one patch in
four formats — unified diff (line numbers may be wrong), SEARCH/REPLACE blocks,
V4A patches, or JSON tool calls — finds the named lines at the first of three
matching tiers (exact, trailing-whitespace-insensitive, leading+trailing-
whitespace-insensitive with re-indent), and changes every file or none.
`--check` dry-runs, `--strict` matches exactly (tier 0 only). Node 22 standard
library only; deterministic, no network.

## Run it

```sh
node main.ts patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=b9zyas72&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
