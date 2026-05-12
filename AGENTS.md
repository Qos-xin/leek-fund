# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

**leek-fund (韭菜盒子)** is a VSCode extension for monitoring real-time financial market data (A-shares, Hong Kong stocks, US stocks, futures, forex, crypto, funds). It uses TypeScript and Yarn as its package manager.

### Key Commands

| Task | Command |
|------|---------|
| Install deps (root) | `yarn install` |
| Install deps (leek-center) | `cd template-packages/leek-center && yarn install` |
| Lint | `yarn lint` |
| Compile (tsc + leek-center build) | `yarn compile` |
| Test (needs Xvfb) | `xvfb-run -a yarn test` |
| Package VSIX | `yarn package` |
| Watch mode | `yarn watch` |

### Gotchas

- **Tests require Xvfb**: The integration tests use `@vscode/test-electron`, which downloads and launches a full VS Code instance. Run with `xvfb-run -a yarn test` in headless environments.
- **`yarn test` runs lint + compile first**: The `pretest` script runs `yarn lint && yarn compile`, so `yarn test` is effectively a full build + test cycle.
- **leek-center sub-package**: The `postcompile` hook automatically builds the `template-packages/leek-center` React app. Its dependencies are managed by a separate `yarn.lock` in that directory. If you modify leek-center code, ensure its dependencies are installed first.
- **`--openssl-legacy-provider`**: The leek-center build requires `NODE_OPTIONS=--openssl-legacy-provider` (already set in its `package.json` scripts via `cross-env`).
- **No database**: All user config is stored via VS Code's `settings.json` and `globalState`. Financial data is fetched in real-time from external APIs (Sina, EastMoney, Binance, etc.).
- **Existing lint warnings are expected**: There are ~12 existing `@typescript-eslint/no-unused-vars` warnings in the codebase. These are known and pre-existing; 0 errors.
