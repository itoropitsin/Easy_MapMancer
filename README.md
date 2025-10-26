
# Easy MapMancer 🗺️

A modern web application for creating and managing interactive maps for tabletop role-playing games with real-time multiplayer support. Built with TypeScript, PixiJS, and WebSockets.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-blue.svg)](https://www.typescriptlang.org/)

## ✨ Features

## 🛠️ Tech Stack

- **Frontend**: TypeScript + PixiJS v8 + Vite
- **Backend**: Node.js + WebSocket (ws)
- **Architecture**: Monorepo with npm workspaces
- **Build System**: TypeScript + Vite
- **Real-time**: WebSocket communication
- **Graphics**: PixiJS for 2D rendering

**Requirements**: Node.js >= 18, npm >= 9

## Key Features

### 🎮 Multiplayer Gaming
- **Real-time synchronization**: All map changes, tokens, and assets sync between all players
- **Role-based access**: DM (Dungeon Master) and Player roles with different permissions
- **WebSocket connection**: Stable connection with automatic reconnection
- **Role switching**: Players can switch between DM and Player roles

### 🗺️ Map and Location Management
- **Location management**: Create, save, and load maps in JSON format
- **Folder organization**: Organize maps in folders with rename and move capabilities
- **Auto-save**: Automatic saving of changes
- **Recent maps**: Quick access to recently used maps
- **Location tree**: Hierarchical file browser for map organization

### 👥 Character Management
- **Tokens**: Create and manage player and NPC tokens
- **Character sheets**: Edit name, HP, AC, stats (STR, DEX, CON, INT, WIS, CHA)
- **Visual customization**: Color, vision radius and angle, emoji icons
- **Notes**: Text notes for each token (up to 2000 characters)
- **Movement**: Drag tokens on grid with snap-to-grid
- **Z-index management**: Control rendering layer order for tokens
- **Hidden tokens**: DM-only visibility toggle
- **Death state**: Mark characters as dead/alive
- **Vision system**: Automatic fog of war reveal based on vision radius

### 🎨 Map Editor
- **Brush tools**: 1x1, 2x2, 3x3, 4x4 cell brushes
- **Floor painting**: 13 types of floor coverings:
  - Basic: Stone, Wood, Water, Sand, Grass
  - Paths: Path, Bridge
  - Coverings: Carpet, Marble
  - Soil: Dirt, Mud
  - Winter: Snow, Ice
- **Asset placement**: 100+ objects across 15 categories:
  - Nature: Trees, rocks, bushes, flowers, mushrooms, cactus, vines, logs
  - Fire: Fire, torch, candle, lantern, campfire
  - Weapons: Sword, bow, axe, spear, mace, dagger, crossbow, shield
  - Armor: Helmet, armor, boots, gloves
  - Containers: Chest, barrel, crate, bag, sack, basket, pouch
  - Kitchen: Pot, pan, plate, bowl, cup, mug, bottle, jar
  - Food: Apple, bread, cheese, meat, fish, cake, cookie, pie
  - Clothing: Hat, cape, boots, gloves, belt, necklace, ring
  - Animals: Cat, dog, horse, cow, pig, sheep, chicken, duck
  - Insects: Bee, butterfly, spider, ant, fly, mosquito, beetle
  - Treasure: Gold, silver, gems, coins, crown, treasure chest
  - Magic: Wand, staff, scroll, potion, crystal, orb
  - Tools: Hammer, pickaxe, shovel, rope, key, lock
  - Furniture: Chair, table, bed, stool, bench
  - Buildings: Wall, window, door
- **Erasers**: Remove tokens, assets, and floor coverings
- **Interactive objects**: Clickable doors that can be opened/closed
- **Procedural generation**: Automatic wall and floor generation based on seed

### 🌫️ Fog of War
- **Automatic reveal**: Based on vision radius for player tokens
- **Manual control**: DM can reveal/hide areas manually
- **Line of Sight**: Considers obstacles (walls, closed doors) for visibility calculation
- **Role differences**: NPCs don't automatically reveal fog
- **Mode switching**: Toggle between automatic and manual fog modes

### 🏗️ Interactive Objects
- **Doors**: Clickable doors that can be opened/closed by any player
- **Walls**: Block movement and line of sight
- **Windows**: Decorative elements
- **Chests and items**: Interactive objects for exploration

### 🎯 Interface and Navigation
- **Panning**: Drag map with mouse
- **Zooming**: Mouse wheel zoom with focus under cursor
- **Mini-map**: Overview of entire map in corner
- **Context menus**: Right-click for quick actions
- **Hotkeys**: Quick access to tools
- **Responsive design**: Support for different screen sizes

### 🔧 Additional Features
- **Undo/Redo**: Complete undo/redo system for all actions (50 action history)
- **Export/Import**: Save and load maps
- **Share**: Generate links for connecting other players
- **Character icons**: 50+ emoji icons for players and NPCs
- **Asset search**: Search and filter assets by category
- **Layer management**: Z-index controls for proper rendering order
- **Hidden objects**: DM-only visibility for tokens and assets

## Repository Structure
```
.
├─ packages/
│  ├─ client/           # Vite + PixiJS client
│  │  ├─ index.html
│  │  └─ src/
│  │     └─ main.ts    # WebSocket connection, grid rendering, tokens
│  ├─ server/           # Node + ws authoritative server
│  │  └─ src/
│  │     └─ index.ts   # WebSocket /ws, events, snapshot, basic permissions
│  └─ shared/           # Shared types and message protocols
│     └─ src/
│        ├─ types.ts
│        └─ protocol.ts
├─ package.json          # npm workspaces, shared scripts
├─ tsconfig.base.json    # base TS settings and aliases
└─ .gitignore
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18 or higher
- npm 9 or higher

### Installation

1. **Clone the repository**:
```bash
git clone https://github.com/yourusername/dnd-map-maker.git
cd dnd-map-maker
```

2. **Install dependencies**:
```bash
npm install
```

3. **Start development server**:
```bash
npm run dev
```

4. **Open the application**:
- **DM (Dungeon Master)**: http://localhost:5173/?inv=dm-local
- **Player**: http://localhost:5173/?inv=pl-local

### 🎮 Controls
- **Move tokens**: Drag with mouse (snap to grid)
- **Pan map**: Drag empty space with left mouse button
- **Zoom**: Mouse wheel (zoom with focus under cursor)
- **Interactive objects**: Click doors to open/close
- **Tools**: Select in left tool panel
- **Map management**: "Maps" button in top-left corner

### Server Connection
- **WebSocket**: ws://localhost:8080/ws
- **HTTP check**: http://localhost:8080/

## 📋 Available Commands

### Development
- `npm run dev` — Run server and client simultaneously
- `npm run server:dev` — Server only in watch mode
- `npm run client:dev` — Client only (Vite dev server)

### Testing
- `npm run test` — Run all tests (integration + unit)
- `npm run test:integration` — Run integration tests only
- `node tests/integration/user-database.test.js` — Run specific test

### Build and Production
- `npm run build` — Build all packages (shared → server → client)
- `npm start` — Run production builds (server + client preview)
- `npm run server:start` — Server only from build
- `npm run client:preview` — Preview built client

### Code Quality
- `npm run format` — Format code with Prettier

## 🚀 Production Deployment

### Build for Production
```bash
npm run build
```

### Run Production Build
```bash
npm start
```

**Available URLs:**
- **Server**: http://localhost:8080 (WebSocket: ws://localhost:8080/ws)
- **Client**: http://localhost:5173
- **DM**: http://localhost:5173/?inv=dm-local
- **Player**: http://localhost:5173/?inv=pl-local

### Environment Variables
- `PORT` — HTTP/WS server port (default: 8080)
- `LOCATIONS_DIR` — Directory for saving maps (default: `packages/server/data/locations`)
- `MAX_PORT` — Maximum port for automatic free port search (default: PORT + 20)

### Usage Examples
```bash
# Run on port 9090
PORT=9090 npm start

# Use different directory for maps
LOCATIONS_DIR=/path/to/maps npm start
```

### Connecting to Different Server
Client can connect to server on different port:
```
http://localhost:5173/?inv=dm-local&port=9090
```

## 🔧 Technical Information

### WebSocket Protocol
**Client → Server:**
- `{ t: "join", name?, invite?, preferredRole? }` — Connect to game
- `{ t: "moveToken", tokenId, pos:{x,y}, levelId }` — Move token
- `{ t: "spawnToken", kind, levelId?, pos?, owner? }` — Create token
- `{ t: "updateToken", tokenId, patch }` — Update token stats
- `{ t: "placeAsset", levelId, pos, kind, rot?, scale?, tint? }` — Place asset
- `{ t: "paintFloor", levelId, pos, kind }` — Paint floor
- `{ t: "revealFog", levelId, cells }` — Reveal fog of war
- `{ t: "obscureFog", levelId, cells }` — Hide with fog of war
- `{ t: "saveLocation", path }` — Save location
- `{ t: "loadLocation", path }` — Load location
- `{ t: "undo" }` — Undo last action
- `{ t: "redo" }` — Redo last undone action

**Server → Client:**
- `{ t: "welcome", playerId, role, snapshot }` — Welcome with initial state
- `{ t: "statePatch", events: [...] }` — State updates
- `{ t: "locationsTree", tree, lastUsedPath? }` — Location tree
- `{ t: "error", message }` — Error message
- `{ t: "undoRedoState", undoStack, redoStack }` — Undo/redo state

### Architecture
- **Monorepo** with npm workspaces
- **Shared types** for client-server synchronization
- **Authoritative server** for validating all actions
- **Event-driven** architecture for state synchronization

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on how to:

- Report bugs
- Suggest new features
- Submit pull requests
- Set up the development environment

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔐 Authentication (since v0.2.0)

- First run: server requires creating the first master user (admin). The client will show a First User screen if no users exist.
- Login: use username or email + password. Successful login sets your role automatically: master → DM, user → Player.
- Session: sessions persist in localStorage and can be resumed on reconnect.
- Admin: masters can list users, create users, change roles, and reset passwords from the UI.

### Data storage

- Users are stored at `packages/server/data/users.json`. Persist this file in production and back it up regularly.

## 🧪 Testing

- Integration test: `tests/integration/user-database.test.js`
- Run all tests:

```bash
npm run test
```

Run the user DB test directly:

```bash
node tests/integration/user-database.test.js
```
