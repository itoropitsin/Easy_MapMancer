# Repository Guidelines

## Project Structure & Module Organization
- Root relies on npm workspaces; all runtime code lives under `packages/` while shared configuration sits in `tsconfig.base.json`.
- `packages/client/` hosts the Pixi-powered UI, with entry code in `src/` and static scaffolding in `index.html`; built assets emit into `dist/`.
- `packages/server/` contains the WebSocket backend in `src/`; TypeScript builds to `dist/` and persists campaign data inside the resolved `data/` directory.
- `packages/shared/` defines cross-package models in `src/`; always import types from this package rather than duplicating literals.

## Build, Test, and Development Commands
- `npm run dev` starts the server via `tsx` and the Vite client concurrently for live development.
- `npm run -w @dnd/server dev` watches the server only; pair it with `PORT=8090` or similar when running multiple instances.
- `npm run -w @dnd/client dev` launches the client at Vite’s default port so you can debug front-end issues in isolation.
- `npm run build` compiles shared types first, then server and client bundles; ensure this passes before publishing changes.
- `npm run start` serves the compiled server and a static Vite preview; use it for staging-style smoke checks.
- `npm run format` applies Prettier across the monorepo; run before committing.

## Coding Style & Naming Conventions
- Node 18+ is required; prefer ES module imports and keep TypeScript strictness intact.
- Follow Prettier defaults (two-space indent, double quotes in JSON) and avoid manual lint overrides unless discussed.
- Name TypeScript types and enums in PascalCase, files in kebab-case (e.g., `level-editor.ts`), and React-like components in PascalCase.
- Co-locate helper modules near their consumers; share reusable logic through `@dnd/shared` instead of cross-importing implementation files.

## Testing Guidelines
- No automated test harness ships today; validate changes by running `npm run build` plus targeted `dev` sessions reproducing the scenario you touched.
- When introducing tests, place them under `packages/<scope>/__tests__/` and document the runner in the PR; prefer Vitest for client code and Node’s built-in `node --test` for server utilities.
- Record manual QA steps and new coverage expectations in the pull request so reviewers can follow the scenario.

## Commit & Pull Request Guidelines
- Favor Conventional Commit prefixes (`feat`, `fix`, `chore`, `refactor`) with optional scopes like `feat(client): add fog tools` to keep history searchable.
- Keep summaries under ~72 characters and reference issue IDs in the body when applicable.
- Pull requests should outline motivation, testing notes, and any data migrations; include before/after screenshots for UI-facing work.
- Mention configuration changes (ports, data directories) explicitly so deployers can adapt environments quickly.

## Security & Configuration Tips
- The server honors `PORT` and `LOCATIONS_DIR`; store secrets in local `.env` files and avoid committing them.
- `packages/server` writes save data beneath the resolved `data/locations` path—never run against a production data directory without backups.
- Validate client-supplied payloads before persisting; prefer the shared type guards when adding new message shapes.
