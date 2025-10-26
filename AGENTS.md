# Repository Guidelines

## Project Structure & Module Organization
- **Root**: npm workspaces configuration with shared TypeScript settings in `tsconfig.base.json`
- **`packages/client/`**: PixiJS-powered frontend with Vite build system
  - Entry point: `src/main.ts` (3900+ lines of client logic)
  - Static assets: `index.html` with comprehensive UI
  - Build output: `dist/` directory
- **`packages/server/`**: Node.js WebSocket backend
  - Main server: `src/index.ts` (1900+ lines of server logic)
  - Data persistence: `data/locations/` directory for JSON maps
  - Build output: `dist/` directory
- **`packages/shared/`**: Cross-package type definitions and protocols
  - Types: `src/types.ts` (Token, Asset, Location, Event definitions)
  - Protocol: `src/protocol.ts` (WebSocket message schemas)
  - Build output: `dist/` with TypeScript declarations

## Build, Test, and Development Commands

### Development
- `npm run dev` — Run server (tsx) and client (Vite) simultaneously for development
- `npm run -w @dnd/server dev` — Server only in watch mode (use `PORT=8090` for multiple instances)
- `npm run -w @dnd/client dev` — Client only on Vite port for frontend debugging

### Production
- `npm run build` — Build all packages (shared → server → client), required before publishing
- `npm run start` — Run production builds for testing
- `npm run format` — Format code with Prettier, run before commits

## Coding Style & Naming Conventions

### TypeScript & JavaScript
- **Node.js**: Version 18+ required, use ES modules
- **TypeScript**: Strict mode enabled, avoid `any` without necessity
- **Formatting**: Prettier with default settings (2 spaces, double quotes in JSON)

### Naming
- **Types and enums**: PascalCase (`Token`, `GameSnapshot`)
- **Files**: kebab-case (`level-editor.ts`, `fog-manager.ts`)
- **Components**: PascalCase (`CharacterPanel`, `LocationTree`)
- **Variables and functions**: camelCase (`currentLocation`, `drawTokens`)

### Architecture
- **Shared logic**: Place in `@dnd/shared`, avoid cross-imports between packages
- **Modules**: Place near consumers, avoid deep nesting
- **Imports**: Use aliases `@dnd/shared` instead of relative paths

## Testing Guidelines

### Current State
- **Automated tests**: Basic integration test exists for user database
- **Validation**: Run `npm run build` + `npm run dev` to verify changes
- **Scenarios**: Reproduce specific use cases in dev mode

### Running Tests

```
npm run test
```

Run specific integration test:

```
node tests/integration/user-database.test.js
```

### Adding Tests
- **Client**: Use Vitest, place in `packages/client/__tests__/`
- **Server**: Use Node.js built-in `node --test`, place in `packages/server/__tests__/`
- **Documentation**: Describe runner and expectations in PR

### Manual Testing
- **Functionality**: Test all affected features
- **Integration**: Test client-server interaction
- **Performance**: Test on large maps with many objects

## Commit & Pull Request Guidelines

### Commits
- **Format**: Conventional Commits with prefixes (`feat`, `fix`, `chore`, `refactor`)
- **Scopes**: Use `feat(client): add fog tools` for grouping
- **Length**: Title up to 72 characters, details in commit body
- **References**: Include issue ID in commit body

### Pull Requests
- **Motivation**: Explain why changes are needed
- **Testing**: Describe how changes were tested
- **Migrations**: Mention data structure changes
- **Screenshots**: Add before/after for UI changes
- **Configuration**: Explicitly specify port, directory, environment variable changes

## Security & Configuration Tips

### Security
- **Secrets**: Store in local `.env` files, don't commit them
- **Validation**: Check all client data before saving
- **Types**: Use shared type guards for new messages
- **Roles**: Check access rights (DM vs Player) on server

### Configuration
- **Ports**: Server uses `PORT` and `MAX_PORT` variables
- **Data**: Maps saved in `LOCATIONS_DIR` (default: `packages/server/data/locations`)
- **Backups**: Never run against production directory without backups
- **Multiple instances**: Use different ports for parallel development

## Implemented Features

### Client (packages/client)
- **PixiJS rendering**: 2D graphics with layer and z-index support
- **Interactive tools**: Brushes, erasers, floor painting, asset placement
- **Token management**: Creation, editing, movement, context menus
- **Fog of war**: Automatic and manual visibility management
- **Navigation**: Panning, zoom, mini-map
- **UI components**: Tool panels, character editor, location tree
- **WebSocket client**: Connection, reconnection, event handling
- **Asset browser**: Searchable asset categories with 100+ objects
- **Character sheets**: Full stat editing with vision and notes
- **Undo/Redo**: Complete action history system

### Server (packages/server)
- **WebSocket server**: Connection handling, roles, authorization
- **State management**: Tokens, assets, fog of war, floor painting
- **File system**: Save/load maps, folder management
- **Validation**: Access rights checking, client data validation
- **Auto-save**: Automatic change saving
- **Procedural generation**: Wall and floor generation based on seed
- **Undo/Redo**: Server-side action history with 50 action limit
- **Role management**: DM/Player role switching
- **Location management**: Full CRUD operations for maps and folders

### Shared (packages/shared)
- **Data types**: Token, Asset, Location, Event, GameSnapshot
- **WebSocket protocol**: ClientToServer and ServerToClient messages
- **Validation**: Type guards for data checking
- **Events**: Event system for state synchronization
- **Undo/Redo**: Action snapshot and state management types

## Development Workflow

### Before Starting
1. Check current branch and pull latest changes
2. Run `npm install` to ensure dependencies are up to date
3. Run `npm run build` to verify everything compiles

### During Development
1. Use `npm run dev` for full development environment
2. Test changes in browser with both DM and Player roles
3. Verify WebSocket communication works correctly
4. Test undo/redo functionality for new features

### Before Committing
1. Run `npm run format` to format code
2. Run `npm run build` to ensure no build errors
3. Test all affected functionality manually
4. Write clear commit message following conventional format

### Code Review Checklist
- [ ] All new features have been tested manually
- [ ] WebSocket protocol changes are backward compatible
- [ ] Type definitions are updated in shared package
- [ ] UI changes are responsive and accessible
- [ ] Performance impact is acceptable for large maps
- [ ] Security implications are considered for DM/Player permissions

## Common Patterns

### Adding New Asset Types
1. Add asset to appropriate category in `packages/client/src/main.ts`
2. Update asset categories object with emoji and name
3. Test asset placement and rendering
4. Consider if asset should be interactive (doors, chests)

### Adding New Floor Types
1. Add floor type to `FloorKind` type in `packages/shared/src/types.ts`
2. Add button in floor panel in `packages/client/index.html`
3. Add event handler in `packages/client/src/main.ts`
4. Update server floor painting logic if needed

### Adding New Token Features
1. Update `Token` interface in `packages/shared/src/types.ts`
2. Add UI controls in character panel
3. Update token rendering logic
4. Add server-side validation and persistence

### WebSocket Message Handling
1. Add message type to `ClientToServer` or `ServerToClient` in `packages/shared/src/protocol.ts`
2. Add handler in server `onMessage` function
3. Add client-side sending logic
4. Add client-side receiving logic
5. Test with multiple clients to ensure synchronization

## Troubleshooting

### Common Issues
- **Build failures**: Check TypeScript errors, run `npm run build` for details
- **WebSocket connection**: Verify server is running on correct port
- **Asset not rendering**: Check if asset is in correct category and has valid emoji
- **Undo/redo not working**: Ensure action snapshots are created before and after changes
- **Permission errors**: Verify role checking logic in server handlers

### Debug Tips
- Use browser dev tools to inspect WebSocket messages
- Check server console for error messages
- Use `console.log` strategically for debugging (remove before commit)
- Test with multiple browser tabs to verify multiplayer functionality
- Check localStorage for recent locations and settings