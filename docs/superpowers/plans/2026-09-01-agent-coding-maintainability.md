# Agent Coding Maintainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Turn the repository's existing engineering and architecture rules into a small repeatable local and CI gate without changing Agent Runtime behavior.

**Architecture:** Add one Node.js script that reads workspace package metadata and TypeScript imports, then enforces only stable dependency-boundary rules. The root `check` script composes typecheck, tests, the architecture check, and whitespace validation; GitHub Actions prepares the pinned runtime and runs the same gate.

**Tech Stack:** Node.js 24.19.0, pnpm 11.22.0, TypeScript compiler API, Vitest 4.1.11, GitHub Actions.

---

### Task 1: Add the architecture gate

**Files:**
- Create: `scripts/check-architecture.mjs`

- [x] Enumerate `packages/*` and `examples/*` package directories and parse each `package.json` with Node's JSON parser.
- [x] Parse TypeScript source imports with the installed TypeScript lexical scanner and collect `@agent-desktop/*` workspace imports from `src/**/*.ts`.
- [x] Fail when a source import is not declared in the package's dependencies, devDependencies, or peerDependencies.
- [x] Treat declared-but-not-statically-imported workspace dependencies as Review signals rather than CI failures, because runtime registration or configuration can be a valid consumer.
- [x] Fail Core package imports or declarations of `react`, `electron`, concrete Provider packages, or concrete Tool packages; fail any package import of an `example-*` package.
- [x] Print each finding and exit nonzero; print a concise pass message when no finding exists.

### Task 2: Normalize local scripts and the test gate

**Files:**
- Modify: `package.json`

- [x] Change `test` to `vitest run` so an empty test suite cannot pass.
- [x] Add `check:architecture` invoking `node scripts/check-architecture.mjs`.
- [x] Add `check` composing `pnpm typecheck && pnpm test && pnpm check:architecture && git diff --check`.

### Task 3: Add the minimal CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [x] Trigger on `push` and `pull_request`.
- [x] Use `actions/checkout@v4` and `actions/setup-node@v4` with Node `24.19.0`.
- [x] Activate pnpm `11.22.0` with the pinned setup action, install with `pnpm install --frozen-lockfile`, then run `pnpm check`.
- [x] Do not add caching, matrices, Docker, release, or external API credentials.

### Task 4: Document the single sources of truth and real verification

**Files:**
- Modify: `docs/engineering.md`
- Modify: `README.md`

- [x] Define `pnpm check` as the local mechanical gate and identify the CI workflow as its hosted equivalent.
- [x] Document that architecture checks cover only stable dependency/import boundaries; remaining behavioral invariants stay in tests and review.
- [x] Document that the five validation layers are a classification model, and that uncovered code or hard-to-test code is a review signal rather than deletion evidence.
- [x] Keep existing `pnpm deepseek-agent` and `pnpm ffmpeg-agent` as the real verification commands, documenting required environment and that missing prerequisites fail clearly.
- [x] State that no standalone Vision-only or full Video Agent E2E command exists because the current repository has no separate production entrypoint for them.
- [x] Avoid copying the full rules from `AGENTS.md` or `docs/architecture.md`; link to those documents by responsibility.

### Task 5: Verify and review

**Files:**
- No production Runtime files changed.

- [x] Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm check:architecture`, `pnpm check`, and `git diff --check`.
- [x] Confirm the test output reports 13 files and 92 tests, and the architecture script reports no findings.
- [x] Inspect the final diff for unrelated files, duplicate mechanisms, future abstractions, or changes to Runtime package boundaries.
- [x] Report current gaps, implemented checks, intentionally omitted checks, local/CI commands, real verification prerequisites, and architecture impact.
