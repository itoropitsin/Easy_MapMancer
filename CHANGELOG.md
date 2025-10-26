# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Planned: Additional asset packs and export options

### Changed
- Nothing yet

### Deprecated
- Nothing yet

### Removed
- Nothing yet

### Fixed
- Nothing yet

### Security
- Nothing yet

## [0.2.0] - 2025-10-26

### Added
- User authentication and session management on server (`packages/server/src/user-manager.ts`)
  - Create first master user flow, login, logout, resume session
  - User roles: `master` and `user` mapped to `DM`/`PLAYER`
  - Password hashing with bcrypt, password reset and change
  - Persistent users storage at `packages/server/data/users.json`
- Client-side authentication screens and flows in `packages/client/src/main.ts`
  - First-user setup UI, login form, error handling, session storage
  - Admin UI: list users, create user, update role, reset password
- History logging enhancements (actor id/name/role) in server events
- New example map: `Road.json`
- Basic test scaffolding and integration test: `tests/integration/user-database.test.js`
- Convenience scripts: `run-tests.js`, `debug-test.js`

### Changed
- Protocol updates in `@dnd/shared` to support auth flows
  - Client → Server: `login`, `resumeSession`, `logout`, `createUser`, `createFirstUser`, `checkFirstUser`, `listUsers`, `updateUserRole`, `deleteUser`, `resetUserPassword`, `changeOwnPassword`
  - Server → Client: corresponding `*Response` messages and `firstUserCheckResponse`
- Server now sets client role from authenticated user role and includes actor info in history
- README and docs expanded with authentication, testing, and deployment notes

### Fixed
- Deduplication and normalization when loading users from disk
- Several stability improvements around role switching and history snapshots for DM

### Security
- Introduced authentication and role-based access control
- Passwords stored as bcrypt hashes; sessions managed server-side
- Security docs updated; recommend persisting `users.json` securely in production

## [0.1.0] - 2024-12-XX

### Added
- Initial release
- Basic map creation and editing
- Token placement and movement
- Multiplayer synchronization
- Asset placement system
- Floor painting tools
- Character management
- Fog of war mechanics
- Map saving and loading
- WebSocket server implementation
- TypeScript monorepo structure
- PixiJS-based rendering engine
