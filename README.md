# Easy MapMancer

Open-source map editor and lightweight virtual tabletop for tabletop RPGs (TTRPGs) with real-time multiplayer.

Create, edit, and run sessions on grid-based maps in your browser. Host the server locally or deploy it anywhere Node.js runs.

## Tech Stack
- **Client**: TypeScript + PixiJS v8 + Vite
- **Server**: Node.js + ws (WebSocket)
- **Shared Types/Protocol**: `@dnd/shared` package
- **Build System**: npm workspaces + TypeScript

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

## Quick Start

### Installation and Setup
1. **Install dependencies**:
```bash
npm install
```

2. **Run in development mode**:
```bash
npm run dev
```

3. **Open the application**:
- **DM (Dungeon Master)**: http://localhost:5173/?inv=dm-local
- **Player**: http://localhost:5173/?inv=pl-local

### Controls
- **Move tokens**: Drag with mouse (snap to grid)
- **Pan map**: Drag empty space with left mouse button
- **Zoom**: Mouse wheel (zoom with focus under cursor)
- **Interactive objects**: Click doors to open/close
- **Tools**: Select in left tool panel
- **Map management**: "Maps" button in top-left corner

### Server Connection
- **WebSocket**: ws://localhost:8080/ws
- **HTTP check**: http://localhost:8080/

## Available Commands

### Development
- `npm run dev` — Run server and client simultaneously
- `npm run server:dev` — Server only in watch mode
- `npm run client:dev` — Client only (Vite dev server)

### Build and Production
- `npm run build` — Build all packages (shared → server → client)
- `npm start` — Run production builds (server + client preview)
- `npm run server:start` — Server only from build
- `npm run client:preview` — Preview built client

### Formatting
- `npm run format` — Format code with Prettier

## Production Deployment

### Build
```bash
npm run build
```

### Run
```bash
npm start
```

**Available URLs:**
- **Server**: http://localhost:8080 (WebSocket: ws://localhost:8080/ws)
- **Client**: http://localhost:5173
- **DM**: http://localhost:5173/?inv=dm-local
- **Player**: http://localhost:5173/?inv=pl-local

## Technical Information

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

## Configuration

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

## License
MIT
