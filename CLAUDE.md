@AGENTS.md

# DraftPage — working in this repo

## Setup
- Node 24 LTS: run `nvm use` first (see `.nvmrc`). `engine-strict` refuses other versions.
- Local database: `docker compose up -d`, then `npm run db:migrate`. Run `npm run db:migrate` again whenever a new migration is added.
- Git hooks: `git config core.hooksPath .githooks` (once per clone; see "Banned names" below).

## Checks before a change is done
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` all pass (CI runs the same).
- Unit and integration tests are Vitest in `tests/**/*.test.ts`. They need the test database: `npm run test:db`.
- Anything verified in a browser becomes a Playwright spec in `tests/e2e/`. Run it with `npm run test:db && npm run test:e2e`.
- New e2e tests must be independent (they run in parallel): see README → Tests.
- Tests live in the repo, never only in a scratch folder.

## Rules
- The code rules are in `.github/ai-review/rules.txt` (imported below). The AI pull-request reviewer uses the same file, so keep it the single source.
- Versions: use the latest stable release of everything, pinned exactly (no `^`/`~`), from the public npm registry.
- The AI never makes a version live, never closes a thread and never deletes a page. A person does those.
- Terraform (`infra/`): write it and run `terraform fmt` / `validate` only. The owner runs `plan`, `apply` and `destroy`. Change one AWS component at a time.
- Ask the owner before every `git commit`, and before anything that leaves this machine (push, AWS, Auth0, publishing). An approval covers only the action it was given for.
- Docs: `README.md` is the public document. Planning notes stay local and out of Git.

## Banned names
- Everything here is original work. Don't copy code from other codebases.
- A private list of names must never appear in files or commit messages.
  - The pattern lives in `.git/info/banned-names` locally and in the `BANNED_NAMES_PATTERN` secret in CI. It is never committed.
  - `scripts/check-banned-names.sh` enforces it through `.githooks/` and CI.

@.github/ai-review/rules.txt
