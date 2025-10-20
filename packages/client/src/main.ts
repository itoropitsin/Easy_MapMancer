function drawWalls() {
  wallsLayer.clear();
  const seed = currentSeed || "demo-seed";
  const s = hashString(seed);
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  const color = 0x6b7280; // gray
  const revealed = levelId ? getRevealed(levelId) : undefined;
  for (let j = 0; j <= tilesY; j++) {
    for (let i = 0; i <= tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const h = hash2D(gx, gy, s);
      // top edge
      if (
        (h & 0x1f) === 0 && isGround(gx, gy) && isGround(gx, gy - 1) &&
        !(myRole !== "DM" && revealed && (!revealed.has(`${gx},${gy}`) && !revealed.has(`${gx},${gy - 1}`)))
      ) {
        const x0 = gx * CELL, y0 = gy * CELL;
        wallsLayer.moveTo(x0, y0).lineTo(x0 + CELL, y0).stroke({ color, width: 2 });
      }
      // left edge
      if (
        ((h >>> 5) & 0x1f) === 0 && isGround(gx, gy) && isGround(gx - 1, gy) &&
        !(myRole !== "DM" && revealed && (!revealed.has(`${gx},${gy}`) && !revealed.has(`${gx - 1},${gy}`)))
      ) {
        const x0 = gx * CELL, y0 = gy * CELL;
        wallsLayer.moveTo(x0, y0).lineTo(x0, y0 + CELL).stroke({ color, width: 2 });
      }
    }
  }
}

function drawObjects() {
  // Placeholder decorative objects disabled by request
  objectsLayer.clear();
  return;
}

import { Application, Graphics, Container, Text, Circle, Rectangle } from "pixi.js";
import type {
  ID,
  Vec2,
  Token,
  Asset,
  FloorKind,
  Location,
  ServerToClient,
  ClientToServer,
  LocationTreeNode,
  Event,
  GameSnapshot,
  FogMode
} from "@dnd/shared";

// Small top-level toast helper for reuse outside connect()
function hudToast(text: string) {
  const hud = document.getElementById("hud");
  if (!hud) return;
  const el = document.createElement("div");
  el.textContent = text;
  el.style.opacity = "0.95";
  el.style.transition = "opacity 0.5s ease";
  hud.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 600); }, 1400);
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function escapeHtml(value: string | number | null | undefined): string {
  const str = String(value ?? "");
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

const CELL = 32;
let playerId: ID | null = null;
let myTokenId: ID | null = null;
let levelId: ID | null = null;
const tokens = new Map<ID, Token>();
let currentLocation: Location | null = null;
let currentSeed: string | null = null;
let myRole: "DM" | "PLAYER" | null = null;
let fogMode: FogMode = "automatic"; // режим открытия тумана войны
const revealedByLevel: Map<ID, Set<string>> = new Map();
const assets = new Map<ID, Asset>();
type EditorMode = "cursor" | "paint" | "eraseObjects" | "eraseSpace" | "revealFog" | "eraseFog" | "eraseTokens" | "spawnToken";
let editorMode: EditorMode = "cursor";
const BRUSH_MODES: EditorMode[] = ["paint", "eraseObjects", "eraseSpace", "revealFog", "eraseFog"];
let selectedTokenId: ID | null = null;
let selectedAssetKind: string | null = null; // when null, floor tools may be used
let selectedFloorKind: FloorKind | null = null;
let selectedTokenKind: "player" | "npc" | null = null;
let painting = false;
let lastPaintKey: string | null = null;
let lastPaintCell: Vec2 | null = null;
let brushSize: 1 | 2 | 3 | 4 = 1;
let locationsExpanded = new Set<string>();
let lastUsedLocationPath: string | undefined;
const SHARE_BASE_URL = typeof window !== "undefined" ? window.location.origin : "";
// Recent locations (client-side only)
let recentLocations: string[] = [];
try { const s = localStorage.getItem("recentLocations"); if (s) recentLocations = JSON.parse(s); } catch {}
function saveRecents() { try { localStorage.setItem("recentLocations", JSON.stringify(recentLocations.slice(0, 10))); } catch {} }
function addRecent(path: string | undefined) {
  if (!path) return;
  recentLocations = [path, ...recentLocations.filter(p => p !== path)].slice(0, 10);
  saveRecents();
}
// Track whether the last pointerdown actually applied an action (to avoid duplicate pointertap handling)
let lastPointerDownDidAct = false;

function brushCells(center: Vec2, size: 1 | 2 | 3 | 4): Vec2[] {
  // Centered brush: for even sizes, bias towards top-left
  const half = Math.floor(size / 2);
  const cells: Vec2[] = [];
  for (let dy = -half; dy < size - half; dy++) {
    for (let dx = -half; dx < size - half; dx++) {
      const gx = center.x + dx; const gy = center.y + dy;
      // No hard bounds: allow painting anywhere; server validates usage via recorded floor overrides
      cells.push({ x: gx, y: gy });
    }
  }
  return cells;
}

function resolveActiveLevel(): ID | null {
  return levelId || (currentLocation?.levels?.[0]?.id as ID | undefined) || null;
}

type BrushResult = { acted: boolean; touchedFloor: boolean };

function cellsBetween(a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (x !== b.x || y !== b.y) {
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    out.push({ x, y });
  }
  return out;
}

function applyBrushAtCell(cell: Vec2): BrushResult {
  let acted = false;
  let touchedFloor = false;
  const cells = brushCells(cell, brushSize);
  if (editorMode === "paint") {
    const lvl = resolveActiveLevel();
    if (!lvl) return { acted, touchedFloor };
    if (!levelId) levelId = lvl;
    for (const c of cells) {
      if (selectedFloorKind) {
        setFloorOverride(lvl, c, selectedFloorKind);
        touchedFloor = true;
        acted = true;
        if (socket) {
          const msg: ClientToServer = { t: "paintFloor", levelId: lvl, pos: c, kind: selectedFloorKind };
          socket.send(JSON.stringify(msg));
        }
      } else if (socket) {
        const kind = selectedAssetKind ?? "tree";
        const msg: ClientToServer = { t: "placeAsset", levelId: lvl, pos: c, kind };
        socket.send(JSON.stringify(msg));
        acted = true;
      }
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseObjects") {
    const lvl = resolveActiveLevel();
    if (!socket || !lvl) return { acted, touchedFloor };
    for (const c of cells) {
      const msg: ClientToServer = { t: "removeAssetAt", levelId: lvl, pos: c };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseSpace") {
    const lvl = resolveActiveLevel();
    if (!lvl) return { acted, touchedFloor };
    for (const c of cells) {
      if (socket) {
        const rm: ClientToServer = { t: "removeAssetAt", levelId: lvl, pos: c };
        socket.send(JSON.stringify(rm));
      }
      setFloorOverride(lvl, c, null);
      touchedFloor = true;
      acted = true;
      if (socket) {
        const fl: ClientToServer = { t: "paintFloor", levelId: lvl, pos: c, kind: null };
        socket.send(JSON.stringify(fl));
      }
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "revealFog") {
    if (socket && levelId) {
      const msg: ClientToServer = { t: "revealFog", levelId, cells };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseFog") {
    if (socket && levelId) {
      const msg: ClientToServer = { t: "obscureFog", levelId, cells };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  return { acted, touchedFloor };
}

// floors overrides, by levelId -> key -> kind
const floorsByLevel: Map<ID, Map<string, FloorKind>> = new Map();
function getFloors(level: ID): Map<string, FloorKind> {
  let m = floorsByLevel.get(level);
  if (!m) { m = new Map(); floorsByLevel.set(level, m); }
  return m;
}
function getFloorOverride(gx: number, gy: number): FloorKind | null {
  if (!levelId) return null;
  const k = `${gx},${gy}`;
  return getFloors(levelId).get(k) ?? null;
}
function setFloorOverride(level: ID, pos: Vec2, kind: FloorKind | null) {
  const m = getFloors(level);
  const k = `${pos.x},${pos.y}`;
  if (kind == null) m.delete(k); else m.set(k, kind);
}

const app = new Application();
await app.init({ background: "#0b0e13", antialias: true, resizeTo: window });
document.getElementById("app")!.appendChild(app.canvas);

// Prevent browser's default context menu on the canvas
app.canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

const world = new Container();
world.sortableChildren = true;
app.stage.addChild(world);
// UI overlay layer (not scaled)
const uiLayer = new Container();
// @ts-ignore
uiLayer.eventMode = "passive"; // allow children to receive events
app.stage.addChild(uiLayer);
// Enable pointer events on stage for drag tracking
// Pixi v8: set eventMode to receive interaction events
// @ts-ignore - eventMode exists in Pixi v8 types
(app.stage as any).eventMode = "static";
const stageHitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
app.stage.hitArea = stageHitArea;
function updateStageHitArea() {
  stageHitArea.width = app.screen.width;
  stageHitArea.height = app.screen.height;
}

// Floor layer
const floor = new Graphics();
world.addChild(floor);

// Grid layer
const grid = new Graphics();
world.addChild(grid);

// Fog-of-war layer (per-cell tiles)
const fogLayer = new Container();
const fogTiles = new Graphics();
fogLayer.addChild(fogTiles);
fogLayer.zIndex = 1000; // overlay above tokens
// ensure fog does not block pointer events
// @ts-ignore Pixi v8 event model
fogLayer.eventMode = "none";

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash2D(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + seed) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Wall sampling mirrors drawWalls():
// top edge at (gx, gy) if (hash2D(gx, gy, s) & 0x1f) === 0
// left edge at (gx, gy) if ((hash2D(gx, gy, s) >>> 5) & 0x1f) === 0
function wallSeed(): number { return hashString(currentSeed || "demo-seed"); }
function hasTopWall(gx: number, gy: number): boolean {
  const h = hash2D(gx, gy, wallSeed());
  return (h & 0x1f) === 0;
}
function hasLeftWall(gx: number, gy: number): boolean {
  const h = hash2D(gx, gy, wallSeed());
  return ((h >>> 5) & 0x1f) === 0;
}
function blockedBetween(a: Vec2, b: Vec2): boolean {
  if (a.x === b.x && a.y === b.y) return false;
  // helper: dynamic blocking by assets (walls and closed doors only)
  const isBlockingAssetAt = (gx: number, gy: number) => {
    for (const a of assets.values()) {
      if (a.levelId !== levelId) continue;
      if (a.pos.x === gx && a.pos.y === gy) {
        if (a.kind === "wall") return true;
        if (a.kind === "door" && (a as any).open !== true) return true;
      }
    }
    return false;
  };
  // Horizontal edge between (a) and (b=a+1,0)
  if (b.x === a.x + 1 && b.y === a.y) return hasLeftWall(b.x, b.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  if (b.x === a.x - 1 && b.y === a.y) return hasLeftWall(a.x, a.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  // Vertical edge between (a) and (b=a+0,1)
  if (b.y === a.y + 1 && b.x === a.x) return hasTopWall(a.x, b.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  if (b.y === a.y - 1 && b.x === a.x) return hasTopWall(a.x, a.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  // Diagonals considered blocked for LOS flood
  return true;
}

function cellsLOS(center: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  const q: Vec2[] = [];
  const seen = new Set<string>();
  const r2 = r * r;
  if (!isGround(center.x, center.y)) return out;
  function push(v: Vec2) {
    const k = cellKey(v);
    if (seen.has(k)) return;
    seen.add(k);
    q.push(v);
    out.push(v);
  }
  push(center);
  while (q.length) {
    const v = q.shift()!;
    const neigh: Vec2[] = [
      { x: v.x + 1, y: v.y },
      { x: v.x - 1, y: v.y },
      { x: v.x, y: v.y + 1 },
      { x: v.x, y: v.y - 1 },
    ];
    for (const n of neigh) {
      if (!isGround(n.x, n.y)) continue;
      const dx = n.x - center.x, dy = n.y - center.y;
      if (dx * dx + dy * dy > r2) continue;
      if (blockedBetween(v, n)) continue;
      push(n);
    }
  }
  return out;
}

function tileColor(gx: number, gy: number, seedStr: string): number {
  const s = hashString(seedStr);
  const n = hash2D(gx, gy, s) & 255; // 0..255
  // Map to two-tone stone floor
  const t = n / 255;
  const base = 0x2b2f36; // dark slate
  const light = 0x39424e; // lighter slate
  // checker weight to avoid banding
  const mix = ((gx ^ gy) & 1) ? t * 0.35 + 0.35 : t * 0.25 + 0.25;
  const r = ((base >> 16) & 0xff) * (1 - mix) + ((light >> 16) & 0xff) * mix;
  const g = ((base >> 8) & 0xff) * (1 - mix) + ((light >> 8) & 0xff) * mix;
  const b = (base & 0xff) * (1 - mix) + (light & 0xff) * mix;
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

type FloorPalette = { light: number; mid: number; dark: number };
const PAINTED_FLOOR_PALETTES: Record<FloorKind, FloorPalette> = {
  stone: { light: 0x848b99, mid: 0x6b7280, dark: 0x4d5360 },
  wood: { light: 0xa86b33, mid: 0x8b5a2b, dark: 0x70421f },
  water: { light: 0x60a5fa, mid: 0x3b82f6, dark: 0x1d4ed8 },
  sand: { light: 0xe3cfa8, mid: 0xd1b892, dark: 0xb9956b },
  grass: { light: 0x62c15d, mid: 0x3f8f3e, dark: 0x2d6b2b },
};

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = lerpChannel(ar, br, t);
  const g = lerpChannel(ag, bg, t);
  const bch = lerpChannel(ab, bb, t);
  return (r << 16) | (g << 8) | bch;
}

function paintedFloorColor(kind: FloorKind, gx: number, gy: number): number {
  const palette = PAINTED_FLOOR_PALETTES[kind];
  if (!palette) return 0xffffff;
  const levelSeed = levelId ? hashString(levelId) : 0;
  const baseSeed = hashString(`${currentSeed || "demo-seed"}:${kind}`);
  const noise = hash2D(gx, gy, baseSeed ^ levelSeed);
  const mixT = ((noise >>> 1) & 0xff) / 255; // 0..1
  const mix = 0.2 + mixT * 0.35; // keep near mid tone
  const useLight = (noise & 1) === 0;
  return useLight ? lerpColor(palette.mid, palette.light, mix) : lerpColor(palette.mid, palette.dark, mix);
}

// 10x10 irregular island mask around (0..9, 0..9)
const ENABLE_PROCEDURAL_LAND = false;
function isLand(gx: number, gy: number): boolean {
  if (!ENABLE_PROCEDURAL_LAND) return false;
  if (gx < 0 || gx >= 10 || gy < 0 || gy >= 10) return false;
  const s = (hashString(currentSeed || "demo-seed") ^ 0xa5a5a5a5) >>> 0;
  const edge = Math.min(gx, gy, 9 - gx, 9 - gy);
  // carve edges a bit for an irregular outline
  if (edge === 0) {
    const h = hash2D(gx, gy, s);
    if ((h & 0xff) < 50) return false; // ~20% edge notches
  } else if (edge === 1) {
    const h = hash2D(gx * 3 + 7, gy * 5 + 11, s);
    if ((h & 0xff) < 20) return false; // subtle bays near edge
  }
  return true;
}

// treat either natural land or painted floor as ground
function isGround(gx: number, gy: number): boolean {
  return isLand(gx, gy) || !!getFloorOverride(gx, gy);
}

function getVisibleBounds() {
  const s = world.scale.x || 1;
  const topLeftX = (-world.position.x) / s;
  const topLeftY = (-world.position.y) / s;
  const viewW = app.screen.width / s;
  const viewH = app.screen.height / s;
  const startGX = Math.floor(topLeftX / CELL) - 1;
  const startGY = Math.floor(topLeftY / CELL) - 1;
  const tilesX = Math.ceil(viewW / CELL) + 3;
  const tilesY = Math.ceil(viewH / CELL) + 3;
  return { startGX, startGY, tilesX, tilesY };
}

function drawFloor() {
  floor.clear();
  const seed = currentSeed || "demo-seed";
  const revealed = levelId ? getRevealed(levelId) : undefined;
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  // Draw starry background on non-land tiles + floor on land tiles
  const sStars = hashString(seed + "*stars");
  for (let j = 0; j < tilesY; j++) {
    for (let i = 0; i < tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const x = gx * CELL, y = gy * CELL;
      const k = `${gx},${gy}`;
      // PLAYER: show pure background on unrevealed ground (draw nothing here)
      if (myRole !== "DM" && revealed && isGround(gx, gy) && !revealed.has(k)) {
        continue;
      }
      // If an override exists, always render a floor tile (creates new land)
      const ov = getFloorOverride(gx, gy);
      if (ov) {
        const col = paintedFloorColor(ov, gx, gy);
        floor.rect(x, y, CELL, CELL).fill(col);
      } else if (isLand(gx, gy)) {
        const color = tileColor(gx, gy, seed);
        floor.rect(x, y, CELL, CELL).fill(color);
      } else {
        const h = hash2D(gx, gy, sStars);
        // a few small stars per some tiles
        if ((h & 0xff) < 8) {
          const ox = ((h >>> 8) & 31) / 31 * CELL;
          const oy = ((h >>> 13) & 31) / 31 * CELL;
          const r = 0.8 + (((h >>> 18) & 3) * 0.4);
          floor.circle(x + ox, y + oy, r).fill({ color: 0xffffff, alpha: 0.85 });
        }
        if (((h >>> 21) & 0xff) < 6) {
          const ox = ((h >>> 29) & 31) / 31 * CELL;
          const oy = ((h >>> 3) & 31) / 31 * CELL;
          const r = 0.6 + (((h >>> 10) & 3) * 0.3);
          floor.circle(x + ox, y + oy, r).fill({ color: 0xbfdfff, alpha: 0.6 });
        }
      }
    }
  }
}

function drawGrid() {
  grid.clear();
  grid.alpha = 0.35;
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  const revealed = levelId ? getRevealed(levelId) : undefined;
  if (myRole === "DM") {
    // DM: regular full-cell grid
    for (let j = 0; j < tilesY; j++) {
      for (let i = 0; i < tilesX; i++) {
        const gx = startGX + i;
        const gy = startGY + j;
        if (!isGround(gx, gy)) continue;
        grid.rect(gx * CELL, gy * CELL, CELL, CELL).stroke({ color: 0x4a5564, width: 1 });
      }
    }
  } else {
    // PLAYER: draw only internal lines between two revealed ground cells (no outer contour)
    const col = 0x4a5564;
    for (let j = 0; j < tilesY; j++) {
      for (let i = 0; i < tilesX; i++) {
        const gx = startGX + i;
        const gy = startGY + j;
        if (!isGround(gx, gy)) continue;
        if (!revealed || !revealed.has(`${gx},${gy}`)) continue;
        const x = gx * CELL, y = gy * CELL;
        // right neighbor
        if (isGround(gx + 1, gy) && revealed.has(`${gx + 1},${gy}`)) {
          grid.moveTo(x + CELL, y);
          grid.lineTo(x + CELL, y + CELL).stroke({ color: col, width: 1 });
        }
        // bottom neighbor
        if (isGround(gx, gy + 1) && revealed.has(`${gx},${gy + 1}`)) {
          grid.moveTo(x, y + CELL);
          grid.lineTo(x + CELL, y + CELL).stroke({ color: col, width: 1 });
        }
      }
    }
  }
}

drawFloor();
drawGrid();
drawFog();
window.addEventListener("resize", () => {
  updateStageHitArea();
  drawFloor();
  drawGrid();
  drawWalls();
  drawObjects();
  drawAssets();
  drawFog();
  drawMinimap();
  positionMinimap();
});

// Walls & objects layers
const wallsLayer = new Graphics();
wallsLayer.zIndex = 200;
world.addChild(wallsLayer);
const objectsLayer = new Graphics();
objectsLayer.zIndex = 300;
world.addChild(objectsLayer);

// Unified layer for all game objects (tokens + assets) to allow z-index sorting between them
const gameObjectsLayer = new Container();
gameObjectsLayer.zIndex = 400;
gameObjectsLayer.sortableChildren = true;
world.addChild(gameObjectsLayer);

// place fog layer after game objects
world.addChild(fogLayer);

// Tokens that the local user can control are drawn above fog
const myTokensLayer = new Container();
myTokensLayer.zIndex = 1100;
myTokensLayer.sortableChildren = true;
world.addChild(myTokensLayer);

// Legacy layers (kept for compatibility but not used for new rendering)
const tokenLayer = new Container();
const assetsLayer = new Container();

// Now that layers exist, draw static content
drawWalls();
drawObjects();

let socket: WebSocket | null = null;
let pendingSocket: WebSocket | null = null;
let connectionAttemptCounter = 0;
let activeAttemptId = 0;
const HEARTBEAT_INTERVAL_MS = 8000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const PING_PAYLOAD = JSON.stringify({ t: "ping" as const });
let heartbeatInterval: number | null = null;
let heartbeatTimeout: number | null = null;
let heartbeatAwaitingPong = false;
let heartbeatAttemptId = 0;
let awaitingInitialPong = false;
let lastConnectedPort: number | null = null;
let reconnectTimer: number | null = null;
let preferredPort: number | null = null;

function stopHeartbeat(attemptId?: number) {
  if (typeof attemptId === "number" && attemptId !== heartbeatAttemptId) return;
  if (heartbeatInterval !== null) {
    window.clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (heartbeatTimeout !== null) {
    window.clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
  heartbeatAwaitingPong = false;
  awaitingInitialPong = false;
  if (typeof attemptId !== "number" || heartbeatAttemptId === attemptId) {
    heartbeatAttemptId = 0;
  }
}

function startHeartbeat(ws: WebSocket, attemptId: number) {
  stopHeartbeat();
  heartbeatAttemptId = attemptId;
  heartbeatAwaitingPong = false;
  awaitingInitialPong = true;
  const sendPing = () => {
    if (attemptId !== activeAttemptId) return;
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(attemptId);
      return;
    }
    if (heartbeatAwaitingPong) {
      try { console.warn(`[WS][client] heartbeat missed on attempt ${attemptId}, forcing reconnect`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
      return;
    }
    heartbeatAwaitingPong = true;
    try {
      ws.send(PING_PAYLOAD);
    } catch (err) {
      heartbeatAwaitingPong = false;
      try { console.warn(`[WS][client] failed to send ping: ${String((err as any)?.message || err)}`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
      return;
    }
    if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
    heartbeatTimeout = window.setTimeout(() => {
      if (!heartbeatAwaitingPong || attemptId !== heartbeatAttemptId) return;
      try { console.warn(`[WS][client] heartbeat timeout on attempt ${attemptId}`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);
  };
  sendPing();
  heartbeatInterval = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
}
type DragState = { tokenId: ID; sprite: Container; offset: Vec2 } | null;
let dragging: DragState = null;

function canControl(tok: Token): boolean {
  return myRole === "DM" || tok.owner === playerId;
}

function snapToGrid(x: number, y: number): Vec2 {
  return { x: Math.floor(x / CELL), y: Math.floor(y / CELL) };
}

function sendMove(tokenId: ID, pos: Vec2) {
  if (!levelId || !socket) return;
  const msg: ClientToServer = { t: "moveToken", tokenId, pos, levelId };
  socket.send(JSON.stringify(msg));
}

function sendUpdateToken(tokenId: ID, patch: Partial<Token>) {
  if (!socket) return;
  const msg: ClientToServer = { t: "updateToken", tokenId, patch };
  socket.send(JSON.stringify(msg));
}

function onDragMove(e: any) {
  if (!dragging) return;
  const p = world.toLocal(e.global);
  // Snap visual during drag to grid center
  const px = p.x + dragging.offset.x;
  const py = p.y + dragging.offset.y;
  const cell = snapToGrid(px, py);
  dragging.sprite.position.set(cell.x * CELL + CELL / 2, cell.y * CELL + CELL / 2);
}

function onDragEnd(e: any) {
  if (!dragging) return;
  const { sprite, tokenId } = dragging;
  sprite.alpha = 1;
  // Snap and send move
  const snapped = snapToGrid(sprite.x, sprite.y);
  // Prevent placing on non-land (space) for players; DM is allowed anywhere
  if (myRole !== "DM" && !isGround(snapped.x, snapped.y)) {
    const tok = tokens.get(tokenId);
    if (tok) sprite.position.set(tok.pos.x * CELL + CELL / 2, tok.pos.y * CELL + CELL / 2);
    try { hudToast("Нельзя перемещаться вне пола/земли"); } catch {}
    dragging = null;
    app.stage.off("pointermove", onDragMove);
    app.stage.off("pointerup", onDragEnd);
    app.stage.off("pointerupoutside", onDragEnd);
    return;
  }
  sendMove(tokenId, snapped);
  // Auto-reveal around the new position using token vision
  if (socket) {
    const tok = tokens.get(tokenId);
    if (tok) {
      const movedTok = { ...(tok as any), pos: snapped };
      const isNPC = (tok as any).kind === "npc";
      if (!isNPC && (myRole === "DM" || tokenId === myTokenId)) {
        revealByVisionForToken(socket as WebSocket, movedTok);
      }
    }
  }
  dragging = null;
  // Remove stage listeners
  app.stage.off("pointermove", onDragMove);
  app.stage.off("pointerup", onDragEnd);
  app.stage.off("pointerupoutside", onDragEnd);
}

// Context menu for object z-index management
let contextMenu: HTMLDivElement | null = null;
let contextMenuTarget: { type: "token"; id: ID } | { type: "asset"; id: ID } | null = null;

function createContextMenu() {
  if (contextMenu) return contextMenu;
  const menu = document.createElement("div");
  menu.id = "object-context-menu";
  menu.style.cssText = `
    position: fixed;
    background: #202124;
    border: 1px solid #5f6368;
    border-radius: 4px;
    padding: 4px 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 10000;
    display: none;
    min-width: 180px;
    font-family: Inter, system-ui, sans-serif;
    font-size: 13px;
  `;
  document.body.appendChild(menu);
  contextMenu = menu;
  
  // Close on click outside
  document.addEventListener("click", () => hideContextMenu());
  
  return menu;
}

function showContextMenu(x: number, y: number, target: { type: "token"; id: ID } | { type: "asset"; id: ID }) {
  console.log(`[CLIENT] showContextMenu called with target:`, target);
  const menu = createContextMenu();
  contextMenuTarget = target;
  
  menu.innerHTML = "";
  
  const addItem = (label: string, action: () => void) => {
    const item = document.createElement("div");
    item.textContent = label;
    item.style.cssText = `
      padding: 6px 12px;
      cursor: pointer;
      color: #e8eaed;
    `;
    item.onmouseenter = () => { item.style.background = "#3c4043"; };
    item.onmouseleave = () => { item.style.background = "transparent"; };
    item.onclick = (e) => {
      e.stopPropagation();
      action();
      hideContextMenu();
    };
    menu.appendChild(item);
  };
  
  addItem("⬆️ На самый верх", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "top" };
      console.log(`[CLIENT] Sending reorderToken:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "top" };
      console.log(`[CLIENT] Sending reorderAsset:`, msg);
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬆ Выше", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "up" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "up" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬇ Ниже", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "down" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "down" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬇️ На самый низ", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "bottom" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "bottom" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  // Add separator
  const separator = document.createElement("div");
  separator.style.cssText = `
    height: 1px;
    background: #5f6368;
    margin: 4px 0;
  `;
  menu.appendChild(separator);
  
  // Add dead toggle option (only for tokens, only for DM)
  if (myRole === "DM" && contextMenuTarget.type === "token") {
    const token = tokens.get(contextMenuTarget.id);
    const isDead = (token as any)?.dead;
    
    addItem(`${isDead ? "❤️" : "💀"} ${isDead ? "Воскресить" : "Убить"}`, () => {
      if (!socket || !contextMenuTarget) return;
      const msg: ClientToServer = { t: "updateToken", tokenId: contextMenuTarget.id, patch: { dead: !isDead } };
      console.log(`[CLIENT] Sending updateToken dead:`, msg);
      socket.send(JSON.stringify(msg));
    });
  }
  
  // Add hidden toggle option (only for DM)
  if (myRole === "DM") {
    const isHidden = contextMenuTarget.type === "token" 
      ? (tokens.get(contextMenuTarget.id) as any)?.hidden 
      : (assets.get(contextMenuTarget.id) as any)?.hidden;
    
    addItem(`${isHidden ? "👁️" : "🙈"} ${isHidden ? "Показать" : "Скрыть"}`, () => {
      if (!socket || !contextMenuTarget) return;
      if (contextMenuTarget.type === "token") {
        const msg: ClientToServer = { t: "toggleTokenHidden", tokenId: contextMenuTarget.id };
        console.log(`[CLIENT] Sending toggleTokenHidden:`, msg);
        socket.send(JSON.stringify(msg));
      } else {
        const msg: ClientToServer = { t: "toggleAssetHidden", assetId: contextMenuTarget.id };
        console.log(`[CLIENT] Sending toggleAssetHidden:`, msg);
        console.log(`[CLIENT] Available assets:`, Array.from(assets.keys()).slice(0, 10));
        socket.send(JSON.stringify(msg));
      }
    });
  }
  
  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = "block";
  
  // Adjust if off-screen
  setTimeout(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  }, 0);
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.style.display = "none";
  }
  contextMenuTarget = null;
}

function drawTokens() {
  console.log(`=== drawTokens() called, myRole=${myRole}, playerId=${playerId}, tokens.size=${tokens.size} ===`);
  
  // Remove existing token nodes from gameObjectsLayer and myTokensLayer
  myTokensLayer.removeChildren();
  // Remove token nodes from gameObjectsLayer
  for (let i = gameObjectsLayer.children.length - 1; i >= 0; i--) {
    const child = gameObjectsLayer.children[i];
    if ((child as any).userData?.type === "token") {
      gameObjectsLayer.removeChild(child);
    }
  }
  
  const revealed = levelId ? getRevealed(levelId) : undefined;
  
  // Sort tokens by zIndex (lower first = drawn first = behind)
  const sortedTokens = Array.from(tokens.values()).sort((a, b) => {
    const zA = (a as any).zIndex ?? 0;
    const zB = (b as any).zIndex ?? 0;
    return zA - zB;
  });
  
  console.log(`Sorted tokens count: ${sortedTokens.length}`);
  
  for (const tok of sortedTokens) {
    // Check if token is hidden and user is not DM
    if ((tok as any).hidden && myRole !== "DM") {
      continue; // Hide token from non-DM users
    }
    
    if (myRole !== "DM" && revealed && tok.id !== myTokenId && !revealed.has(`${tok.pos.x},${tok.pos.y}`)) {
      // hide non-owned tokens in unrevealed cells for player
      continue;
    }
    const node = new Container();
    const isNPC = (tok as any).kind === "npc";
    const isMine = tok.id === myTokenId;
    // Emoji-like token appearance
    const emoji = isNPC ? "🧟" : "🧙";
    const text = new Text({
      text: emoji,
      style: {
        fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
        fontSize: Math.floor(CELL * 1.05),
        stroke: 0x202124,
        strokeThickness: 1,
      }
    } as any);
    (text as any).anchor?.set?.(0.5);
    text.position.set(0, 0);
    const labelRaw = (tok.name ?? "").trim();
    const labelText = labelRaw ? Array.from(labelRaw).slice(0, 6).join("") : "";
    const label = labelText ? new Text({
      text: labelText,
      style: {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: Math.floor(CELL * 0.3),
        fill: 0xffffff,
        stroke: 0x202124,
        strokeThickness: 2,
        align: "center",
      }
    } as any) : null;
    if (label) {
      (label as any).anchor?.set?.(0.5, 0);
      label.position.set(0, CELL * 0.42);
    }
    // Subtle ring to improve visibility/select state
    const ring = new Graphics();
    const ringColor = isMine ? 0x8ab4f8 : 0x9aa0a6;
    ring.circle(0, 0, CELL * 0.46).stroke({ color: ringColor, width: 2, alpha: 0.8 });
    
    // Add background overlay for health status
    const backgroundOverlay = new Graphics();
    const hp = (tok as any).hp || 0;
    const isDead = (tok as any).dead;
    
    if (isDead) {
      // Black background for dead characters
      backgroundOverlay.circle(0, 0, CELL * 0.48).fill({ color: 0x000000, alpha: 0.6 });
    } else if (hp === 0) {
      // Red background for characters with 0 HP
      backgroundOverlay.circle(0, 0, CELL * 0.48).fill({ color: 0xff0000, alpha: 0.6 });
    }
    
    // Check if token is hidden for DM
    const isHidden = (tok as any).hidden && myRole === "DM";
    
    // Add skull icon for dead characters
    let skullIcon: Text | null = null;
    if (isDead) {
      skullIcon = new Text({
        text: "💀",
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.3),
          stroke: 0x202124,
          strokeThickness: 1,
        }
      } as any);
      (skullIcon as any).anchor?.set?.(1, 0);
      skullIcon.position.set(CELL * 0.35, -CELL * 0.35);
    }
    
    // Compose
    // @ts-ignore
    node.addChild(backgroundOverlay);
    // @ts-ignore
    node.addChild(ring);
    // @ts-ignore
    node.addChild(text);
    if (label) {
      // @ts-ignore
      node.addChild(label);
    }
    if (skullIcon) {
      // @ts-ignore
      node.addChild(skullIcon);
    }
    
    // Add eye icon for hidden tokens (only visible to DM)
    if (isHidden) {
      const eyeIcon = new Text({
        text: "👁️",
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.4),
          stroke: 0x202124,
          strokeThickness: 1,
        }
      } as any);
      (eyeIcon as any).anchor?.set?.(0.5);
      eyeIcon.position.set(CELL * 0.3, -CELL * 0.3);
      // @ts-ignore
      node.addChild(eyeIcon);
      
      // Make token semi-transparent but keep eye icon fully visible
      node.alpha = 0.5;
      eyeIcon.alpha = 1.0;
    }
    node.position.set(tok.pos.x * CELL + CELL / 2, tok.pos.y * CELL + CELL / 2);
    // Mark as token for cleanup
    (node as any).userData = { type: "token" };
    // Enlarge hit area to make grabbing easier
    try { (node as any).hitArea = new Circle(0, 0, CELL * 0.55); } catch {}
    
    // Set zIndex for proper layering (tokens use range 0-99)
    node.zIndex = (tok as any).zIndex ?? 0;
    
    // Decide which layer to use
    const shouldBeAboveFog = myRole === "PLAYER" && tok.owner === playerId;
    console.log(`Token processing: name=${tok.name}, owner=${tok.owner}, myRole=${myRole}, playerId=${playerId}, shouldBeAboveFog=${shouldBeAboveFog}, canControl=${canControl(tok)}`);
    
    // Drag & drop
    if (canControl(tok)) {
      // @ts-ignore v8 event model
      node.eventMode = "static";
      (node as any).cursor = "grab";
      node.on("pointerdown", (e: any) => {
        // If editor tool is active, do not start token drag
        if (myRole === "DM" && (editorMode === "paint" || editorMode === "eraseObjects" || editorMode === "eraseSpace" || editorMode === "eraseTokens" || editorMode === "spawnToken")) {
          document.body.style.cursor = "crosshair";
          e.stopPropagation?.();
          return;
        }
        (node as any).cursor = "grabbing";
        node.alpha = 0.9;
        const p0 = world.toLocal(e.global);
        const off = { x: node.x - p0.x, y: node.y - p0.y };
        dragging = { tokenId: tok.id, sprite: node, offset: off };
        app.stage.on("pointermove", onDragMove);
        app.stage.on("pointerup", onDragEnd);
        app.stage.on("pointerupoutside", onDragEnd);
        e.stopPropagation?.();
      });
      node.on("pointerup", () => { (node as any).cursor = "grab"; });
      node.on("pointerupoutside", () => { (node as any).cursor = "grab"; });
      node.on("pointertap", (e: any) => { 
        e.stopPropagation?.();
        if (editorMode === "eraseTokens" && myRole === "DM" && socket) {
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } };
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      // Right-click context menu for z-index management
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "token", id: tok.id });
      });
      
      // Add to appropriate layer
      if (shouldBeAboveFog) {
        myTokensLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} (controllable) at (${tok.pos.x}, ${tok.pos.y}) with zIndex=${node.zIndex} → myTokensLayer`);
      } else {
        gameObjectsLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} (controllable) at (${tok.pos.x}, ${tok.pos.y}) with zIndex=${node.zIndex} → gameObjectsLayer`);
      }
    } else {
      // Non-controllable tokens
      // @ts-ignore
      node.eventMode = "static";
      node.on("pointertap", (e: any) => { 
        e.stopPropagation?.();
        if (editorMode === "eraseTokens" && myRole === "DM" && socket) {
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } };
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      // Right-click context menu for z-index management
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "token", id: tok.id });
      });
      
      // Add to appropriate layer
      if (shouldBeAboveFog) {
        myTokensLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} at (${tok.pos.x}, ${tok.pos.y}) with zIndex=${node.zIndex} → myTokensLayer`);
      } else {
        gameObjectsLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} at (${tok.pos.x}, ${tok.pos.y}) with zIndex=${node.zIndex} → gameObjectsLayer`);
      }
    }
  }
  // Force sort children by zIndex
  gameObjectsLayer.sortChildren();
  console.log(`=== drawTokens() complete. gameObjectsLayer children: ${gameObjectsLayer.children.length}, myTokensLayer children: ${myTokensLayer.children.length} ===`);
}

// Simple character panel renderer. Expects an element with id "right-panel" to exist.
function renderCharacterPanel() {
  const panel = document.getElementById("right-panel");
  if (!panel) return; // panel not present in DOM yet
  const tok = selectedTokenId ? tokens.get(selectedTokenId) : null;
  if (!tok) {
    panel.innerHTML = '<div class="char-header">Лист персонажа</div><div style="opacity:.7">Нет выбранного токена</div>';
    return;
  }
  const anyTok: any = tok as any;
  const stats = anyTok.stats || {};
  const vr = Math.max(0, Math.min(20, Number(anyTok.vision?.radius ?? 0) || 0));
  const editable = canControl(tok);
  const notes = typeof anyTok.notes === "string" ? anyTok.notes : "";
  const formatNumber = (value: any) => {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "";
  };
  const renderInput = (opts: { id: string; type: string; value: string; placeholder?: string; attrs?: string }) => {
    const placeholder = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : "";
    const extra = opts.attrs ? ` ${opts.attrs}` : "";
    return `<input id="${opts.id}" class="char-input" type="${opts.type}" value="${escapeHtml(opts.value)}"${placeholder}${extra} />`;
  };
  const iconMarkup = (kind: string): string => {
    if (kind.startsWith("stat-")) {
      const code = kind.slice(5).toUpperCase();
      return `<span class="char-icon char-icon--abbr">${escapeHtml(code)}</span>`;
    }
    switch (kind) {
      case "name":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" fill="currentColor" opacity="0.9"/><path d="M6.2 19c.6-2.5 2.8-4.5 5.8-4.5s5.2 2 5.8 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      case "hp":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5 6.2 13.7a4 4 0 0 1 0-5.6 4 4 0 0 1 5.6 0l.2.3.2-.3a4 4 0 0 1 5.6 0 4 4 0 0 1 0 5.6L12 19.5Z" fill="currentColor"/></svg></span>`;
      case "ac":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-4.4-1.9-7.5-5.1-7.5-9.3V6.4L12 3l7.5 3.4v5.3c0 4.2-3.1 7.4-7.5 9.3Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 11.2v4.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>`;
      case "vision":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/></svg></span>`;
      default:
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>`;
    }
  };
  type FieldVariant = "stat";
  type FieldConfig = { icon: string; label: string; input: string; hint?: string; variant?: FieldVariant; hideLabel?: boolean };
  const renderField = (cfg: FieldConfig) => {
    const classes = ["char-field"];
    if (cfg.variant === "stat") classes.push("char-field--stat");
    const hintHtml = cfg.hint ? `<span class="char-hint">${escapeHtml(cfg.hint)}</span>` : "";
    const labelHtml = cfg.hideLabel ? "" : `<div class="char-label">${escapeHtml(cfg.label)}</div>`;
    return `<div class="${classes.join(" ")}">${iconMarkup(cfg.icon)}${labelHtml}<div class="char-control">${cfg.input}${hintHtml}</div></div>`;
  };
  const profileFields: FieldConfig[] = [
    {
      icon: "name",
      label: "Имя",
      input: renderInput({ id: "char-name", type: "text", value: tok.name ?? "", placeholder: "Имя" }),
    },
  ];
  const combatFields: FieldConfig[] = [
    {
      icon: "hp",
      label: "HP",
      input: renderInput({ id: "char-hp", type: "number", value: formatNumber(anyTok.hp), placeholder: "0", attrs: 'inputmode="numeric"' }),
    },
    {
      icon: "ac",
      label: "AC",
      input: renderInput({ id: "char-ac", type: "number", value: formatNumber(anyTok.ac), placeholder: "0", attrs: 'inputmode="numeric"' }),
    },
    {
      icon: "dead",
      label: "Dead",
      input: `<label class="char-checkbox-label">
        <input id="char-dead" type="checkbox" ${anyTok.dead ? 'checked' : ''} />
        <span class="char-checkbox-text">Мертв</span>
      </label>`,
    },
  ];
  const statKeys: Array<{ key: keyof NonNullable<Token["stats"]>; label: string }> = [
    { key: "str", label: "STR" },
    { key: "dex", label: "DEX" },
    { key: "con", label: "CON" },
    { key: "int", label: "INT" },
    { key: "wis", label: "WIS" },
    { key: "cha", label: "CHA" },
  ];
  const statsFields = statKeys.map(({ key, label }) => renderField({
    icon: `stat-${key}`,
    label,
    input: renderInput({ id: `char-${key}`, type: "number", value: formatNumber((stats as any)[key]), placeholder: "-", attrs: `inputmode="numeric" aria-label="${label}"` }),
    variant: "stat",
    hideLabel: true,
  }));
  const visionField = renderField({
    icon: "vision",
    label: "Видимость",
    input: renderInput({ id: "char-vision-radius", type: "number", value: String(vr), attrs: 'inputmode="numeric" min="0" max="20"' }),
    hint: "радиус (0-20)",
  });
  panel.innerHTML = `
    <div class="char-header">Лист персонажа</div>
    <div class="char-section">
      <div class="char-section-title">Профиль</div>
      <div class="char-fields-grid char-fields-grid--two">
        ${profileFields.map(renderField).join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Боевые параметры</div>
      <div class="char-fields-grid char-fields-grid--two">
        ${combatFields.map(renderField).join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Характеристики</div>
      <div class="char-stats-grid">
        ${statsFields.join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Видимость</div>
      <div class="char-fields-grid">
        ${visionField}
      </div>
    </div>
    <div class="char-section char-notes-wrapper">
      <label for="char-notes">Заметки</label>
      <textarea id="char-notes" placeholder="Свободный текст...">${escapeHtml(notes)}</textarea>
    </div>
  `;
  // Enable/disable based on permissions
  const q = (sel: string) => panel.querySelector(sel) as HTMLInputElement | null;
  const setDisabled = (el: HTMLInputElement | null) => { if (el) el.disabled = !editable; };
  ["#char-name", "#char-hp", "#char-ac", "#char-str", "#char-dex", "#char-con", "#char-int", "#char-wis", "#char-cha", "#char-vision-radius", "#char-dead"].forEach(id => setDisabled(q(id)));
  // Helpers
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const parseNum = (el: HTMLInputElement, lo?: number, hi?: number) => {
    const n = Number(el.value);
    if (!Number.isFinite(n)) return undefined;
    const v = (lo == null || hi == null) ? n : clamp(n, lo!, hi!);
    el.value = String(v);
    return v;
  };
  // Wire updates
  const nameEl = q("#char-name");
  nameEl?.addEventListener("change", () => { if (!editable) return; sendUpdateToken(tok.id, { name: nameEl.value.trim() }); });
  const hpEl = q("#char-hp");
  hpEl?.addEventListener("change", () => { if (!editable) return; const v = parseNum(hpEl, 0, 999); if (v != null) sendUpdateToken(tok.id, { hp: v }); });
  const acEl = q("#char-ac");
  acEl?.addEventListener("change", () => { if (!editable) return; const v = parseNum(acEl, 0, 99); if (v != null) sendUpdateToken(tok.id, { ac: v }); });
  const statIds: Array<[keyof NonNullable<Token["stats"]>, string]> = [["str", "#char-str"], ["dex", "#char-dex"], ["con", "#char-con"], ["int", "#char-int"], ["wis", "#char-wis"], ["cha", "#char-cha"]];
  for (const [k, sel] of statIds) {
    const el = q(sel);
    el?.addEventListener("change", () => {
      if (!editable) return;
      const v = parseNum(el, -99, 99);
      if (v != null) {
        const statsPatch: Partial<NonNullable<Token["stats"]>> = { [k]: v };
        sendUpdateToken(tok.id, { stats: statsPatch });
      }
    });
  }
  const vrEl = q("#char-vision-radius");
  vrEl?.addEventListener("change", () => {
    if (!editable) return;
    const v = parseNum(vrEl, 0, 20);
    if (v != null) {
      sendUpdateToken(tok.id, { vision: { radius: v } });
      // provide immediate feedback for DM by revealing with new radius
      if (myRole === "DM" && socket) {
        const tmp: any = { ...tok, vision: { ...(anyTok.vision || {}), radius: v } };
        revealByVisionForToken(socket as WebSocket, tmp);
      }
    }
  });
  const notesEl = panel.querySelector("#char-notes") as HTMLTextAreaElement | null;
  notesEl?.addEventListener("change", () => {
    if (!editable) return;
    const next = (notesEl.value || "").slice(0, 2000);
    sendUpdateToken(tok.id, { notes: next });
  });
  if (notesEl) notesEl.disabled = !editable;
  
  const deadEl = q("#char-dead");
  deadEl?.addEventListener("change", () => {
    if (!editable) return;
    sendUpdateToken(tok.id, { dead: deadEl.checked });
  });
}

function drawAssets() {
  console.log(`=== drawAssets() called, gameObjectsLayer.children.length BEFORE cleanup: ${gameObjectsLayer.children.length} ===`);
  
  // Remove existing asset nodes from gameObjectsLayer
  for (let i = gameObjectsLayer.children.length - 1; i >= 0; i--) {
    const child = gameObjectsLayer.children[i];
    if ((child as any).userData?.type === "asset") {
      gameObjectsLayer.removeChild(child);
    }
  }
  
  console.log(`gameObjectsLayer.children.length AFTER cleanup: ${gameObjectsLayer.children.length}`);
  
  if (!levelId) return;
  const revealed = getRevealed(levelId);
  
  // Sort assets by zIndex (lower first = drawn first = behind)
  const allAssets = Array.from(assets.values());
  console.log(`[CLIENT] drawAssets: total assets=${allAssets.length}, current levelId=${levelId}`);
  console.log(`[CLIENT] drawAssets: assets by level:`, allAssets.reduce((acc, a) => {
    acc[a.levelId] = (acc[a.levelId] || 0) + 1;
    return acc;
  }, {} as Record<string, number>));
  
  const sortedAssets = allAssets
    .filter(a => a.levelId === levelId)
    .filter(a => {
      // Check if asset is hidden and user is not DM
      if ((a as any).hidden && myRole !== "DM") {
        return false; // Hide asset from non-DM users
      }
      return myRole === "DM" || revealed.has(`${a.pos.x},${a.pos.y}`);
    })
    .sort((a, b) => {
      const zA = (a as any).zIndex ?? 0;
      const zB = (b as any).zIndex ?? 0;
      return zA - zB;
    });
  
  console.log(`[CLIENT] drawAssets: filtered assets for level ${levelId}: ${sortedAssets.length}`);
  
  // Build occupancy map for structural connections (walls/windows/doors)
  const byKey = new Map<string, { kind: string; open?: boolean }>();
  for (const a of sortedAssets) {
    byKey.set(`${a.pos.x},${a.pos.y}`, { kind: a.kind, open: (a as any).open });
  }
  const isWallLike = (cell: { kind: string; open?: boolean } | undefined) => {
    if (!cell) return false;
    if (cell.kind === "door") return !cell.open; // closed door behaves like wall
    return cell.kind === "wall" || cell.kind === "window";
  };
  for (const a of sortedAssets) {
    console.log(`[CLIENT] Drawing asset: kind=${a.kind}, id=${a.id}, pos=(${a.pos.x}, ${a.pos.y})`);
    const node = new Container();
    // Linear, connected styles for building structures
    if (a.kind === "wall" || a.kind === "window" || a.kind === "door") {
      const g = new Graphics();
      if (a.kind === "wall") {
        const t = CELL * 0.16;
        const L = byKey.get(`${a.pos.x - 1},${a.pos.y}`);
        const R = byKey.get(`${a.pos.x + 1},${a.pos.y}`);
        const U = byKey.get(`${a.pos.x},${a.pos.y - 1}`);
        const D = byKey.get(`${a.pos.x},${a.pos.y + 1}`);
        const hasH = isWallLike(L) || isWallLike(R);
        const hasV = isWallLike(U) || isWallLike(D);
        const col = 0x6b7280, stroke = 0x4b5563;
        if (hasH) g.rect(-CELL / 2, -t / 2, CELL, t).fill(col).stroke({ color: stroke, width: 2 });
        if (hasV) g.rect(-t / 2, -CELL / 2, t, CELL).fill(col).stroke({ color: stroke, width: 2 });
        if (!hasH && !hasV) g.rect(-t / 2, -t / 2, t, t).fill(col).stroke({ color: stroke, width: 2 });
      } else if (a.kind === "window") {
        const t = CELL * 0.14;
        const L = byKey.get(`${a.pos.x - 1},${a.pos.y}`);
        const R = byKey.get(`${a.pos.x + 1},${a.pos.y}`);
        const U = byKey.get(`${a.pos.x},${a.pos.y - 1}`);
        const D = byKey.get(`${a.pos.x},${a.pos.y + 1}`);
        const hasH = isWallLike(L) || isWallLike(R);
        const hasV = isWallLike(U) || isWallLike(D);
        const fill = { color: 0x66ccff, alpha: 0.9 } as any;
        const stroke = 0x1d4ed8;
        if (hasH) g.roundRect(-CELL / 2, -t / 2, CELL, t, 6).fill(fill).stroke({ color: stroke, width: 2 });
        if (hasV) g.roundRect(-t / 2, -CELL / 2, t, CELL, 6).fill(fill).stroke({ color: stroke, width: 2 });
        if (!hasH && !hasV) g.roundRect(-CELL * 0.25, -CELL * 0.12, CELL * 0.5, CELL * 0.24, 6).fill(fill).stroke({ color: stroke, width: 2 });
      } else if (a.kind === "door") {
        const L = byKey.get(`${a.pos.x - 1},${a.pos.y}`);
        const R = byKey.get(`${a.pos.x + 1},${a.pos.y}`);
        const U = byKey.get(`${a.pos.x},${a.pos.y - 1}`);
        const D = byKey.get(`${a.pos.x},${a.pos.y + 1}`);
        const horiz = isWallLike(L) || isWallLike(R);
        const vert = isWallLike(U) || isWallLike(D);
        const t = CELL * 0.18;
        const col = 0x8b5a2b, stroke = 0x5a3a1c;
        const open = (a as any).open === true;
        if (!open) {
          if (horiz && !vert) g.rect(-CELL / 2, -t / 2, CELL, t).fill(col).stroke({ color: stroke, width: 2 });
          else if (vert && !horiz) g.rect(-t / 2, -CELL / 2, t, CELL).fill(col).stroke({ color: stroke, width: 2 });
          else g.rect(-t / 2, -t / 2, t, t).fill(col).stroke({ color: stroke, width: 2 });
        } else {
          const w = CELL * 0.7, h = t;
          g.rect(-w / 2, -h / 2, w, h).fill(col).stroke({ color: stroke, width: 2 });
          g.rotation = horiz ? Math.PI / 4 : -Math.PI / 4;
        }
      }
      node.addChild(g as any);
      node.position.set(a.pos.x * CELL + CELL / 2, a.pos.y * CELL + CELL / 2);
      (node as any).userData = { type: "asset" };
      if (typeof a.scale === "number") node.scale.set(a.scale);
      if (typeof a.rot === "number") node.rotation = a.rot;
      if (typeof a.tint === "number") (node as any).tint = a.tint;
      
      // Add eye icon for hidden assets (only visible to DM)
      const isHidden = (a as any).hidden && myRole === "DM";
      if (isHidden) {
        const eyeIcon = new Text({
          text: "👁️",
          style: {
            fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
            fontSize: Math.floor(CELL * 0.3),
            stroke: 0x202124,
            strokeThickness: 1,
          }
        } as any);
        (eyeIcon as any).anchor?.set?.(0.5);
        eyeIcon.position.set(CELL * 0.25, -CELL * 0.25);
        node.addChild(eyeIcon as any);
        
        // Make asset semi-transparent but keep eye icon fully visible
        node.alpha = 0.5;
        eyeIcon.alpha = 1.0;
      }
    } else {
      // Emoji-like for decorative items
      const emojiFor = (k: string): string => {
        switch (k) {
          case "tree": return "🌳";
          case "rock": return "🪨";
          case "bush": return "🌿";
          case "chest": return "📦";
          case "sword": return "🗡️";
          case "bow": return "🏹";
          case "coins": return "🪙";
          case "other": return "✨";
          default: return "✨";
        }
      };
      const label = new Text({
        text: emojiFor(a.kind),
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.9),
          align: "center",
        }
      } as any);
      (label as any).anchor?.set?.(0.5);
      label.position.set(0, 0);
      node.addChild(label as any);
      node.position.set(a.pos.x * CELL + CELL / 2, a.pos.y * CELL + CELL / 2);
      (node as any).userData = { type: "asset" };
      if (typeof a.scale === "number") node.scale.set(a.scale);
      if (typeof a.rot === "number") node.rotation = a.rot;
      if (typeof a.tint === "number") (label as any).tint = a.tint;
      
      // Add eye icon for hidden assets (only visible to DM)
      const isHidden = (a as any).hidden && myRole === "DM";
      if (isHidden) {
        const eyeIcon = new Text({
          text: "👁️",
          style: {
            fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
            fontSize: Math.floor(CELL * 0.3),
            stroke: 0x202124,
            strokeThickness: 1,
          }
        } as any);
        (eyeIcon as any).anchor?.set?.(0.5);
        eyeIcon.position.set(CELL * 0.25, -CELL * 0.25);
        node.addChild(eyeIcon as any);
        
        // Make asset semi-transparent but keep eye icon fully visible
        node.alpha = 0.5;
        eyeIcon.alpha = 1.0;
      }
    }
    // Enable dragging assets in cursor mode for DM
    if (myRole === "DM") {
      // @ts-ignore pixi v8 events
      node.eventMode = "static";
      node.cursor = editorMode === "cursor" ? "grab" : "default";
      node.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        // door toggle takes priority
        if (a.kind === "door" && socket) {
          const msg: ClientToServer = { t: "toggleDoor", assetId: a.id };
          socket.send(JSON.stringify(msg));
          e.stopPropagation?.();
          return;
        }
        const p0 = world.toLocal(e.global);
        const off = { x: node.x - p0.x, y: node.y - p0.y };
        draggingAsset = { assetId: a.id, kind: a.kind, sprite: node, offset: off, from: { ...a.pos } };
        node.cursor = "grabbing";
        // stage listeners
        app.stage.on("pointermove", onAssetDragMove);
        app.stage.on("pointerup", onAssetDragEnd);
        app.stage.on("pointerupoutside", onAssetDragEnd);
        e.stopPropagation?.();
      });
    }
    // Doors should be clickable for players (DM handled above to avoid double toggle)
    if (a.kind === "door" && myRole !== "DM") {
      // @ts-ignore
      node.eventMode = "static";
      node.cursor = editorMode === "cursor" ? "pointer" : node.cursor;
      node.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        if (!socket) return;
        const msg: ClientToServer = { t: "toggleDoor", assetId: a.id };
        socket.send(JSON.stringify(msg));
        e.stopPropagation?.();
      });
    }
    // Right-click context menu for z-index management (for all assets)
    if (myRole === "DM" || a.kind === "door") {
      if (!node.eventMode || node.eventMode === "auto") {
        // @ts-ignore
        node.eventMode = "static";
      }
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "asset", id: a.id });
      });
    }
    // Add to gameObjectsLayer with zIndex (both assets and tokens use same zIndex range)
    node.zIndex = (a as any).zIndex ?? 0;
    gameObjectsLayer.addChild(node);
    console.log(`Asset ${a.kind} at (${a.pos.x}, ${a.pos.y}) with zIndex=${node.zIndex}`);
  }
  // Force sort children by zIndex
  gameObjectsLayer.sortChildren();
  console.log(`Total objects in gameObjectsLayer: ${gameObjectsLayer.children.length}`);
}

type DraggingAsset = { assetId: ID; kind: string; sprite: Container; offset: { x: number; y: number }; from: Vec2 } | null;
let draggingAsset: DraggingAsset = null;
function onAssetDragMove(e: any) {
  if (!draggingAsset) return;
  const p = world.toLocal(e.global);
  const px = p.x + draggingAsset.offset.x;
  const py = p.y + draggingAsset.offset.y;
  const cell = snapToGrid(px, py);
  draggingAsset.sprite.position.set(cell.x * CELL + CELL / 2, cell.y * CELL + CELL / 2);
}
function onAssetDragEnd(e: any) {
  if (!draggingAsset) return;
  const { sprite, from, assetId } = draggingAsset;
  const snapped = snapToGrid(sprite.x, sprite.y);
  // revert if invalid
  if (!levelId || !socket) {
    sprite.position.set(from.x * CELL + CELL / 2, from.y * CELL + CELL / 2);
  } else {
    // use moveAsset to preserve ID
    const msg: ClientToServer = { t: "moveAsset", assetId, levelId, pos: snapped };
    socket.send(JSON.stringify(msg));
  }
  draggingAsset = null;
  app.stage.off("pointermove", onAssetDragMove);
  app.stage.off("pointerup", onAssetDragEnd);
  app.stage.off("pointerupoutside", onAssetDragEnd);
}

function cellKey(v: Vec2): string { return `${v.x},${v.y}`; }

function getRevealed(level: ID): Set<string> {
  let s = revealedByLevel.get(level);
  if (!s) { s = new Set(); revealedByLevel.set(level, s); }
  return s;
}

function drawFog() {
  fogTiles.clear();
  if (!levelId) return;
  // For PLAYER we do not draw any fog tiles at all — background/floor rendering handles concealment
  if (myRole !== "DM") return;
  const revealed = getRevealed(levelId);
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  for (let j = 0; j < tilesY; j++) {
    for (let i = 0; i < tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const k = `${gx},${gy}`;
      if (isGround(gx, gy) && !revealed.has(k)) {
        // DM: semi-transparent overlay to allow editing through fog
        fogTiles.rect(gx * CELL, gy * CELL, CELL, CELL).fill({ color: 0x000000, alpha: 0.6 });
      }
    }
  }
}

function cellsInRadius(center: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        out.push({ x: center.x + dx, y: center.y + dy });
      }
    }
  }
  return out;
}

function sendRevealAround(ws: WebSocket, center: Vec2, r: number) {
  if (!levelId) return;
  const cells = cellsInRadius(center, r);
  const msg: ClientToServer = { t: "revealFog", levelId, cells };
  ws.send(JSON.stringify(msg));
}

function sendRevealLOS(ws: WebSocket, center: Vec2, r: number) {
  if (!levelId) return;
  const cells = cellsLOS(center, r);
  const msg: ClientToServer = { t: "revealFog", levelId, cells };
  ws.send(JSON.stringify(msg));
}

function getTokenVisionRadius(t: any): number {
  const r = Number(t?.vision?.radius ?? 0);
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(20, r));
}

function revealByVisionForToken(ws: WebSocket, t: any) {
  if (!t || !levelId) return;
  if (t.levelId !== levelId) return; // only reveal on current level
  // Only player tokens should auto-reveal fog; NPCs must not
  if ((t as any).kind === "npc") return;
  // Only auto-reveal if fog mode is automatic
  if (fogMode !== "automatic") return;
  const r = getTokenVisionRadius(t);
  if (r > 0) sendRevealLOS(ws, t.pos, r);
}

function connect() {
  // Single-run guard (HMR-safe)
  const w = window as any;
  if (w.__DND_WS_CONNECT_SCHEDULED) { try { console.debug("[WS][client] connect() already scheduled, skipping"); } catch {} return; }
  w.__DND_WS_CONNECT_SCHEDULED = true;

  // HUD status (reuse if present)
  const hud = document.getElementById("hud");
  let statusEl = document.getElementById("status") as HTMLDivElement | null;
  if (!statusEl) { statusEl = document.createElement("div"); statusEl.id = "status"; hud?.appendChild(statusEl); }
  let mapInfoEl = document.getElementById("map-info") as HTMLDivElement | null;
  if (!mapInfoEl) { mapInfoEl = document.createElement("div"); mapInfoEl.id = "map-info"; hud?.appendChild(mapInfoEl); }
  let shareButtonEl = document.getElementById("btn-share") as HTMLButtonElement | null;
  let shareLink: string | null = null;
  const buildShareLink = (): string | null => {
    if (!SHARE_BASE_URL || !currentLocation?.id) return null;
    try {
      const url = new URL(`/map/${currentLocation.id}/`, SHARE_BASE_URL);
      return url.toString();
    } catch (err) {
      try { console.warn("[Share] Failed to build link", err); } catch {}
      return null;
    }
  };
  const refreshShareButton = () => {
    if (!shareButtonEl) return;
    shareLink = buildShareLink();
    const hasLink = Boolean(shareLink);
    shareButtonEl.disabled = !hasLink;
    shareButtonEl.setAttribute("title", hasLink ? "Скопировать ссылку на карту" : "Ссылка недоступна");
  };
  const setStatus = (text: string, state: "connecting" | "connected" | "disconnected" | "error") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state;
  };
  const setMapName = (name: string | null | undefined) => {
    if (!mapInfoEl) return;
    const trimmed = (name ?? "").trim();
    const value = trimmed.length ? trimmed : "—";
    mapInfoEl.textContent = value;
    mapInfoEl.setAttribute("title", value);
    refreshShareButton();
  };
  setStatus("WS: connecting...", "connecting");
  setMapName(null);
  refreshShareButton();
  shareButtonEl?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const link = buildShareLink();
    if (!link) {
      refreshShareButton();
      hudToast("Ссылка пока недоступна");
      return;
    }
    shareLink = link;
    const copyViaClipboard = async () => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        return true;
      }
      return false;
    };
    let copied = false;
    try {
      copied = await copyViaClipboard();
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = link;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        copied = document.execCommand("copy");
        textArea.remove();
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      try {
        prompt("Скопируйте ссылку на карту:", link);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (copied) {
      hudToast("Ссылка скопирована");
    } else {
      hudToast("Не удалось скопировать ссылку");
    }
  });

  const params = new URLSearchParams(location.search);
  // Parse map ID from URL path or query parameter
  let mapId: string | null = null;
  const pathMatch = location.pathname.match(/\/map\/([^\/]+)\/?/);
  if (pathMatch) {
    mapId = pathMatch[1];
  } else {
    mapId = params.get("loc");
  }
  const inv = "pl-local"; // Always use player role by default, role switching is handled via UI
  const startPort = Number(params.get("port") || 8080);
  const endPort = Number(params.get("maxPort") || (startPort + 20));
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname;

  let currentPort = startPort;
  let connecting = false;
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const attachHandlers = (ws: WebSocket, port: number, attemptId: number) => {
    let handshakeComplete = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (attemptId !== activeAttemptId || handshakeComplete) return;
      try { console.warn(`[WS][client] handshake timeout on :${port}`); } catch {}
      setStatus("WS: handshake timeout", "error");
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
    }, 5000);
    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    ws.addEventListener("message", (ev) => {
      if (attemptId !== activeAttemptId) return;
      const msg: ServerToClient = JSON.parse(ev.data);
      console.log(`[CLIENT] Received message:`, msg.t, msg);
      if (msg.t === "welcome") {
        handshakeComplete = true;
        clearHandshakeTimer();
        pendingSocket = null;
        socket = ws;
        preferredPort = port;
        currentPort = port;
        lastConnectedPort = port;
        setStatus(`WS: проверка соединения (:${port})...`, "connecting");
        startHeartbeat(ws, attemptId);
        playerId = msg.playerId;
        myRole = msg.role;
        // store location/seed
        currentLocation = msg.snapshot.location;
        fogMode = currentLocation?.fogMode ?? "automatic";
        // Update HUD map name and URL with location ID
        try {
        setMapName(currentLocation?.name);
        if (currentLocation?.id) {
          const newUrl = `${window.location.origin}/map/${currentLocation.id}/`;
          history.replaceState(null, "", newUrl);
        }
        } catch {}
        // pick first token owned by me
        tokens.clear();
        for (const t of msg.snapshot.tokens) {
          tokens.set(t.id, t);
          if (t.owner === playerId) { myTokenId = t.id; levelId = t.levelId; }
        }
        // receive assets
        assets.clear();
        console.log(`[CLIENT] Receiving snapshot with ${((msg.snapshot as any).assets ?? []).length} assets`);
        for (const a of (msg.snapshot as any).assets ?? []) {
          assets.set(a.id, a);
        }
        console.log(`[CLIENT] First 5 asset IDs from snapshot:`, Array.from(assets.keys()).slice(0, 5));
        // receive floors
        const floorsArr = (msg.snapshot as any).floors as { levelId: ID; pos: Vec2; kind: FloorKind }[] | undefined;
        if (Array.isArray(floorsArr)) {
          for (const f of floorsArr) setFloorOverride(f.levelId, f.pos, f.kind);
        }
        // Ensure we have a levelId even if we don't own a token
        if (!levelId && currentLocation) {
          levelId = currentLocation.levels[0]?.id ?? null;
        }
        // choose seed for current level
        if (currentLocation && levelId) {
          const lvl = currentLocation.levels.find(l => l.id === levelId);
          currentSeed = lvl?.seed ?? null;
        }
        // apply existing fog from snapshot events, if any
        const evs = (msg as any).snapshot?.events as any[] | undefined;
        if (Array.isArray(evs)) {
          for (const e of evs) {
            if (e.type === "fogRevealed") {
              const set = getRevealed(e.levelId as ID);
              for (const c of e.cells) set.add(cellKey(c));
            }
          }
        }
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        centerOnMyToken();
        drawMinimap(); positionMinimap();
        // update UI state based on role
        try { (updateEditorUI as any)(); } catch {}
        // update user menu
        try { (updateUserMenu as any)(); } catch {}
        // auto-reveal around DM token on join to make map visible
        if (myRole === "DM") {
          for (const t of tokens.values()) {
            revealByVisionForToken(ws, t as any);
          }
        }
        drawFog();
        renderCharacterPanel();
        // Ask server for locations list after initial sync
        try { requestLocationsList(); } catch {}
        return;
      }
      if (!handshakeComplete) {
        try { console.warn(`[WS][client] ignoring message before welcome: ${String((msg as any)?.t ?? "unknown")}`); } catch {}
        return;
      }
      if (msg.t === "pong") {
        if (heartbeatAttemptId === attemptId) {
          heartbeatAwaitingPong = false;
          if (heartbeatTimeout !== null) {
            window.clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
          }
          if (awaitingInitialPong) {
            awaitingInitialPong = false;
            const suffix = lastConnectedPort != null ? ` (:${lastConnectedPort})` : "";
            setStatus(`WS: connected${suffix}`, "connected");
          }
        }
        return;
      }
      if ((msg as any).t === "saveData") {
        const data = (msg as any).snapshot;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = URL.createObjectURL(blob);
        a.download = `dnd-location-${ts}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else if ((msg as any).t === "reset") {
        const snap = (msg as any).snapshot as { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] };
        // apply snapshot fresh
        playerId = playerId; // unchanged
        myRole = myRole; // unchanged
        currentLocation = snap.location;
        fogMode = currentLocation?.fogMode ?? "automatic";
        // Update HUD map name and URL with location ID
        try {
        setMapName(currentLocation?.name);
        if (currentLocation?.id) {
          const newUrl = `${window.location.origin}/map/${currentLocation.id}/`;
          history.replaceState(null, "", newUrl);
        }
        } catch {}
        tokens.clear();
        for (const t of snap.tokens) {
          tokens.set(t.id, t);
        }
        // pick my token if exists
        myTokenId = null;
        for (const t of snap.tokens) { if (t.owner === playerId) { myTokenId = t.id; break; } }
        // ensure level id/seed
        levelId = myTokenId ? tokens.get(myTokenId!)?.levelId ?? null : (currentLocation?.levels[0]?.id ?? null);
        if (currentLocation && levelId) {
          const lvl = currentLocation.levels.find(l => l.id === levelId);
          currentSeed = lvl?.seed ?? null;
        }
        // assets
        assets.clear();
        for (const a of snap.assets) assets.set(a.id, a);
        // floors
        floorsByLevel.clear();
        if (Array.isArray(snap.floors)) {
          for (const f of snap.floors) setFloorOverride(f.levelId, f.pos, f.kind);
        }
        // fog
        revealedByLevel.clear();
        if (Array.isArray(snap.events)) {
          for (const e of snap.events) {
            if ((e as any).type === "fogRevealed") {
              const set = getRevealed((e as any).levelId as ID);
              for (const c of (e as any).cells) set.add(cellKey(c));
            }
          }
        }
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        centerOnMyToken();
        drawMinimap(); positionMinimap();
        drawFog();
        renderCharacterPanel();
        // ensure locations list is refreshed after switching/creating maps
        try { requestLocationsList(); } catch {}
      } else if (msg.t === "statePatch") {
        console.log(`[CLIENT] Received statePatch with ${msg.events.length} events`);
        console.log(`[CLIENT] Event types:`, msg.events.map(e => e.type));
        for (const e of msg.events) {
          if (e.type === "tokenSpawned") {
            tokens.set(e.token.id, e.token);
            if (e.token.owner === playerId) {
              myTokenId = e.token.id;
              levelId = e.token.levelId;
            }
            if (myRole === "DM") {
              revealByVisionForToken(ws, e.token as any);
            }
          } else if (e.type === "tokenRemoved") {
            tokens.delete(e.tokenId);
            if (selectedTokenId === e.tokenId) {
              selectedTokenId = null;
              renderCharacterPanel();
            }
          } else if (e.type === "tokenMoved") {
            const tok = tokens.get(e.tokenId); if (tok) { tok.pos = e.pos; tok.levelId = e.levelId; if (myRole === "DM") { revealByVisionForToken(ws, tok as any); } }
          } else if (e.type === "fogRevealed") {
            const set = getRevealed(e.levelId as ID);
            for (const c of e.cells) set.add(cellKey(c));
          } else if ((e as any).type === "fogObscured") {
            const set = getRevealed((e as any).levelId as ID);
            for (const c of (e as any).cells) set.delete(cellKey(c));
          } else if ((e as any).type === "fogModeChanged") {
            fogMode = (e as any).fogMode as FogMode;
            updateFogModeUI();
          } else if ((e as any).type === "assetPlaced") {
            const a = (e as any).asset as Asset;
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect zIndex changes
          } else if ((e as any).type === "assetUpdated") {
            const a = (e as any).asset as Asset;
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect changes
          } else if ((e as any).type === "assetRemoved") {
            const id = (e as any).assetId as ID;
            assets.delete(id);
            drawAssets();
          } else if ((e as any).type === "assetMoved") {
            const a = (e as any).asset as Asset;
            console.log(`[CLIENT] Asset moved: ${a.id} to (${a.pos.x}, ${a.pos.y})`);
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect position changes
          } else if ((e as any).type === "floorPainted") {
            const ev = e as any as { levelId: ID; pos: Vec2; kind: FloorKind | null };
            setFloorOverride(ev.levelId, ev.pos, ev.kind ?? null);
          } else if ((e as any).type === "undoPerformed") {
            console.log(`[CLIENT] Undo performed, refreshing display`);
            // The gameStateRestored event will handle the full refresh
          } else if ((e as any).type === "redoPerformed") {
            console.log(`[CLIENT] Redo performed, refreshing display`);
            // The gameStateRestored event will handle the full refresh
          } else if ((e as any).type === "tokenUpdated") {
            const anyE: any = e as any;
            if (anyE.token) {
              const full: any = anyE.token;
              tokens.set(full.id, full);
              drawTokens(); // Redraw to reflect zIndex changes
              if (myRole === "DM") revealByVisionForToken(ws, full as any);
            } else {
              const ev = e as any as { type: string; tokenId: ID; patch: any };
              const t = tokens.get(ev.tokenId);
              if (t) {
                Object.assign(t, ev.patch || {});
                drawTokens(); // Redraw in case zIndex changed
                if (myRole === "DM") revealByVisionForToken(ws, t as any);
              }
            }
          }
        }
        drawTokens();
        drawAssets();
        drawFloor();
        drawGrid();
        drawWalls();
        drawFog();
        drawMinimap();
      } else if (msg.t === "locationsTree") {
        try {
          const hasDemo = (() => {
            const exists = (nodes: any[]): boolean => {
              for (const n of nodes) {
                if ((n as any).type === "file") {
                  const p = String((n as any).path || "").toLowerCase();
                  if ((n as any).name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
                }
                if ((n as any).children?.length && exists((n as any).children)) return true;
              }
              return false;
            };
            return exists((msg as any).tree || []);
          })();
          console.debug(`[LOC][client] received locationsTree: nodes=${(msg as any).tree?.length ?? 0}, lastUsed=${msg.lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        lastUsedLocationPath = msg.lastUsedPath;
        if (lastUsedLocationPath) addRecent(lastUsedLocationPath);
        renderLocationsTree(msg.tree, lastUsedLocationPath);
      } else if (msg.t === "savedOk") {
        // lightweight toast and refresh locations list
        hudToast(`Сохранено: ${msg.path}`);
        addRecent(msg.path);
        try { requestLocationsList(); } catch {}
      } else if (msg.t === "roleChanged") {
        myRole = (msg as any).role;
        try { (updateEditorUI as any)(); } catch {}
        try { (updateUserMenu as any)(); } catch {}
        hudToast(`Роль изменена на: ${myRole === "DM" ? "Администратор" : "Игрок"}`);
      } else if (msg.t === "undoRedoState") {
        console.log(`[CLIENT] Received undoRedoState:`, (msg as any).undoStack.length, (msg as any).redoStack.length);
        updateUndoRedoButtons((msg as any).undoStack, (msg as any).redoStack);
      } else if (msg.t === "gameStateRestored") {
        console.log(`[CLIENT] Received gameStateRestored, refreshing display`);
        console.log(`[CLIENT] Current assets count: ${assets.size}`);
        console.log(`[CLIENT] Current tokens count: ${tokens.size}`);
        console.log(`[CLIENT] Current floors count: ${floors.size}`);
        // Refresh all visual elements after state restoration
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        drawFog();
        drawMinimap();
        positionMinimap();
        renderCharacterPanel();
      } else if ((msg as any).t === "error") {
        // show error toast for server-side failures
        try { hudToast(`Ошибка: ${(msg as any).message || "неизвестная ошибка"}`); } catch {}
      }
    });
    ws.addEventListener("close", (ev) => {
      if (attemptId !== activeAttemptId) return;
      clearHandshakeTimer();
      if (socket === ws) socket = null;
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      if (socket === null) lastConnectedPort = null;
      setStatus("WS: disconnected", "disconnected");
      try { console.warn(`[WS][client] disconnected from :${port} code=${(ev as any)?.code}`); } catch {}
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        tryConnectSequence();
      }, 1000);
    });
    ws.addEventListener("error", () => {
      if (attemptId !== activeAttemptId) return;
      clearHandshakeTimer();
      if (socket === ws) socket = null;
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      if (socket === null) lastConnectedPort = null;
      setStatus("WS: error", "error");
    });
  };

  async function tryConnectSequence() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (connecting) return;
    connecting = true;
    if (preferredPort != null) {
      currentPort = preferredPort;
    }
    while (true) {
      const port = currentPort;
      const wsUrl = `${protocol}://${host}:${port}/ws?inv=${encodeURIComponent(inv)}`;
      try { console.debug(`[WS][client] trying ${wsUrl}`); } catch {}
      const attemptId = ++connectionAttemptCounter;
      activeAttemptId = attemptId;
      setStatus(`WS: connecting (:${port})...`, "connecting");
      const ws = new WebSocket(wsUrl);
      pendingSocket = ws;
      const opened = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean) => { if (done) return; done = true; resolve(value); };
        const ok = () => {
          if (attemptId !== activeAttemptId) { finish(false); return; }
          finish(true);
        };
        const fail = () => {
          if (attemptId !== activeAttemptId) { finish(false); return; }
          finish(false);
        };
        ws.addEventListener("open", ok, { once: true } as any);
        ws.addEventListener("error", fail, { once: true } as any);
        ws.addEventListener("close", fail, { once: true } as any);
      });
      if (opened && attemptId === activeAttemptId) {
        try { console.log(`[WS][client] connected on :${port}`); } catch {}
        const preferredRole = loadUserRole();
        const joinMsg: ClientToServer = { t: "join", name: "Player", invite: inv, preferredRole };
        try { ws.send(JSON.stringify(joinMsg)); } catch {}
        
        // Load location by ID if specified in URL
        if (mapId) {
          const loadMsg: ClientToServer = { t: "loadLocationById", locationId: mapId };
          try { ws.send(JSON.stringify(loadMsg)); } catch {}
        }
        
        attachHandlers(ws, port, attemptId);
        connecting = false;
        return;
      }
      if (attemptId !== activeAttemptId) {
        try { ws.close(); } catch {}
        continue;
      }
      try { console.warn(`[WS][client] failed to connect on :${port}`); } catch {}
      if (pendingSocket === ws) pendingSocket = null;
      setStatus("WS: offline, повтор подключения...", "error");
      try { ws.close(); } catch {}
      if (preferredPort == null) {
        currentPort = port + 1 > endPort ? startPort : (port + 1);
      } else {
        currentPort = preferredPort;
      }
      await delay(500);
    }
  }

  try { console.debug(`[WS][client] connect(): scanning ports ${startPort}-${endPort}`); } catch {}
  tryConnectSequence();

  // Left panel controls
  const btnCursor = document.getElementById("btn-tool-cursor") as HTMLButtonElement | null;
  const btnEraseTokens = document.getElementById("btn-tool-erase-tokens") as HTMLButtonElement | null;
  const btnEraseObjects = document.getElementById("btn-tool-erase-objects") as HTMLButtonElement | null;
  const btnEraseSpace = document.getElementById("btn-tool-erase-space") as HTMLButtonElement | null;
  const btnAssetTree = document.getElementById("asset-tree") as HTMLButtonElement | null;
  const btnAssetRock = document.getElementById("asset-rock") as HTMLButtonElement | null;
  const btnAssetBush = document.getElementById("asset-bush") as HTMLButtonElement | null;
  const btnAssetWall = document.getElementById("asset-wall") as HTMLButtonElement | null;
  const btnAssetWindow = document.getElementById("asset-window") as HTMLButtonElement | null;
  const btnAssetDoor = document.getElementById("asset-door") as HTMLButtonElement | null;
  const btnAssetChest = document.getElementById("asset-chest") as HTMLButtonElement | null;
  const btnAssetSword = document.getElementById("asset-sword") as HTMLButtonElement | null;
  const btnAssetBow = document.getElementById("asset-bow") as HTMLButtonElement | null;
  const btnAssetCoins = document.getElementById("asset-coins") as HTMLButtonElement | null;
  const btnAssetOther = document.getElementById("asset-other") as HTMLButtonElement | null;
  const btnFloorStone = document.getElementById("floor-stone") as HTMLButtonElement | null;
  const btnFloorWood = document.getElementById("floor-wood") as HTMLButtonElement | null;
  const btnFloorWater = document.getElementById("floor-water") as HTMLButtonElement | null;
  const btnFloorSand = document.getElementById("floor-sand") as HTMLButtonElement | null;
  const btnFloorGrass = document.getElementById("floor-grass") as HTMLButtonElement | null;
  const btnNewMap = document.getElementById("btn-new-map") as HTMLButtonElement | null;
  const btnNewFolder = document.getElementById("btn-new-folder") as HTMLButtonElement | null;
  const btnAddPlayer = document.getElementById("btn-add-player") as HTMLButtonElement | null;
  const btnAddNPC = document.getElementById("btn-add-npc") as HTMLButtonElement | null;
  const btnUndo = document.getElementById("btn-undo") as HTMLButtonElement | null;
  const btnRedo = document.getElementById("btn-redo") as HTMLButtonElement | null;
  const locationsTreeEl = document.getElementById("locations-tree") as HTMLDivElement | null;
  const btnBrush1 = document.getElementById("brush-1") as HTMLButtonElement | null;
  const btnBrush2 = document.getElementById("brush-2") as HTMLButtonElement | null;
  const btnBrush3 = document.getElementById("brush-3") as HTMLButtonElement | null;
  const btnBrush4 = document.getElementById("brush-4") as HTMLButtonElement | null;
  const btnRevealFog = document.getElementById("btn-tool-reveal-fog") as HTMLButtonElement | null;
  const btnEraseFog = document.getElementById("btn-tool-erase-fog") as HTMLButtonElement | null;
  const locationsDrawerEl = document.getElementById("locations-drawer") as HTMLDivElement | null;
  const locationsToggleBtn = document.getElementById("locations-toggle") as HTMLButtonElement | null;
  const locationsCloseBtn = document.getElementById("locations-close") as HTMLButtonElement | null;
  const dockButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#tool-dock .dock-btn"));

  let activeToolPanel: HTMLElement | null = null;
  let activeDockButton: HTMLButtonElement | null = null;

  function closeToolPanels() {
    // Remove 'open' class from all panels
    const allToolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    allToolPanels.forEach(panel => {
      panel.classList.remove("open");
    });

    // Remove 'open' class from all dock buttons
    const allDockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    allDockButtons.forEach(btn => {
      btn.classList.remove("open");
    });

    // Reset state variables
    activeToolPanel = null;
    activeDockButton = null;
  }

  function positionPanelForButton(btn: HTMLButtonElement, panel: HTMLElement) {
    // Don't position panels for hidden buttons
    if (btn.style.display === 'none') {
      return;
    }
    
    const rect = btn.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 260; // Default width if not calculated yet
    const panelHeight = panel.offsetHeight || 200; // Default height if not calculated yet
    
    // Calculate position relative to viewport
    let left = rect.right + 14;
    // Position panel to align with the center of the button (CSS transform handles the centering)
    let top = rect.top + rect.height / 2;
    
    // Ensure panel doesn't go off-screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Adjust horizontal position if panel would go off-screen
    if (left + panelWidth > viewportWidth - 20) {
      left = rect.left - panelWidth - 14; // Position to the left of button
    }
    
    // Adjust vertical position if panel would go off-screen
    if (top < 20) {
      top = 20;
    } else if (top + panelHeight > viewportHeight - 20) {
      top = viewportHeight - panelHeight - 20;
    }
    
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function toggleToolPanel(btn: HTMLButtonElement, panel: HTMLElement) {
    // Don't open panels for hidden buttons or hidden panels
    if (btn.style.display === 'none' || panel.style.display === 'none') {
      return;
    }
    
    // Check if this panel is already open
    if (panel.classList.contains("open")) {
      closeToolPanels();
      return;
    }
    
    // Close all other panels first
    closeToolPanels();
    
    // Open this panel
    positionPanelForButton(btn, panel);
    panel.classList.add("open");
    btn.classList.add("open");
    activeToolPanel = panel;
    activeDockButton = btn;
  }

  dockButtons.forEach((btn) => {
    const panelId = btn.dataset.panel;
    if (!panelId) return;
    const panel = document.getElementById(panelId) as HTMLElement | null;
    if (!panel) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleToolPanel(btn, panel);
    });
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target as Node | null;
    if (activeToolPanel && target && !activeToolPanel.contains(target) && !activeDockButton?.contains(target as Node)) {
      closeToolPanels();
    }
  });
  window.addEventListener("resize", () => closeToolPanels());

  let locationsDrawerOpen = false;
  const setLocationsOpen = (open: boolean) => {
    locationsDrawerOpen = open;
    if (locationsDrawerEl) {
      locationsDrawerEl.classList.toggle("open", open);
      locationsDrawerEl.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (locationsToggleBtn) {
      locationsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    document.body.classList.toggle("locations-open", open);
    if (open) closeToolPanels();
  };
  const toggleLocations = () => setLocationsOpen(!locationsDrawerOpen);
  const closeLocations = () => setLocationsOpen(false);

  locationsToggleBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleLocations();
  });
  locationsCloseBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeLocations();
  });

  document.addEventListener("click", (ev) => {
    if (!locationsDrawerOpen) return;
    const target = ev.target as Node | null;
    if (locationsDrawerEl?.contains(target) || locationsToggleBtn?.contains(target as Node)) return;
    closeLocations();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (locationsDrawerOpen) closeLocations();
      if (activeToolPanel) closeToolPanels();
    }
  });

  setLocationsOpen(false);

  // User menu handlers
  const userIcon = document.getElementById("user-icon") as HTMLButtonElement | null;
  const userDropdown = document.getElementById("user-dropdown") as HTMLDivElement | null;
  const userRole = document.getElementById("user-role") as HTMLDivElement | null;
  const userName = document.getElementById("user-name") as HTMLDivElement | null;
  const switchToDmBtn = document.getElementById("switch-to-dm") as HTMLButtonElement | null;
  const switchToPlayerBtn = document.getElementById("switch-to-player") as HTMLButtonElement | null;

  let userMenuOpen = false;

  function saveUserRole(role: "DM" | "PLAYER") {
    try {
      localStorage.setItem("dnd-user-role", role);
    } catch (e) {
      console.warn("Failed to save user role:", e);
    }
  }

  function loadUserRole(): "DM" | "PLAYER" {
    try {
      const saved = localStorage.getItem("dnd-user-role");
      console.log(`[CLIENT] loadUserRole: saved=${saved}`);
      // If no saved role or it's PLAYER, default to DM
      const role = (saved === "DM") ? "DM" : "DM";
      console.log(`[CLIENT] loadUserRole: returning=${role}`);
      return role;
    } catch (e) {
      console.warn("Failed to load user role:", e);
      return "DM";
    }
  }

  function updateUserMenu() {
    if (!userRole || !userName || !switchToDmBtn || !switchToPlayerBtn || !userIcon) return;
    
    const isDM = myRole === "DM";
    userRole.textContent = isDM ? "Мастер" : "Игрок";
    userRole.className = `user-role ${isDM ? "dm" : ""}`;
    userName.textContent = "Пользователь"; // Можно добавить имя пользователя позже
    
    // Показываем кнопку переключения на противоположную роль
    switchToDmBtn.style.display = isDM ? "none" : "flex";
    switchToPlayerBtn.style.display = isDM ? "flex" : "none";
    
    // Обновляем иконку
    userIcon.className = `user-icon ${isDM ? "dm" : ""}`;
  }

  function toggleUserMenu() {
    if (!userDropdown) return;
    userMenuOpen = !userMenuOpen;
    userDropdown.classList.toggle("open", userMenuOpen);
    userIcon?.setAttribute("aria-expanded", userMenuOpen ? "true" : "false");
  }

  function closeUserMenu() {
    if (!userDropdown) return;
    userMenuOpen = false;
    userDropdown.classList.remove("open");
    userIcon?.setAttribute("aria-expanded", "false");
  }

  userIcon?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleUserMenu();
  });

  switchToDmBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (socket) {
      // Отправляем запрос на смену роли на DM
      const msg: ClientToServer = { t: "switchRole", role: "DM" };
      socket.send(JSON.stringify(msg));
      saveUserRole("DM");
    }
    closeUserMenu();
  });

  switchToPlayerBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (socket) {
      // Отправляем запрос на смену роли на PLAYER
      const msg: ClientToServer = { t: "switchRole", role: "PLAYER" };
      socket.send(JSON.stringify(msg));
      saveUserRole("PLAYER");
    }
    closeUserMenu();
  });

  // Закрываем меню при клике вне его
  document.addEventListener("click", (ev) => {
    if (userMenuOpen && userDropdown && !userDropdown.contains(ev.target as Node) && !userIcon?.contains(ev.target as Node)) {
      closeUserMenu();
    }
  });

  // Инициализируем меню пользователя
  updateUserMenu();

  btnUndo?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeToolPanels();
    console.log(`[CLIENT] Undo button clicked, role: ${myRole}, socket: ${!!socket}`);
    if (socket && myRole === "DM") {
      const msg: ClientToServer = { t: "undo" };
      console.log(`[CLIENT] Sending undo message:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      hudToast("Только DM может отменять действия");
    }
  });
  btnRedo?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeToolPanels();
    console.log(`[CLIENT] Redo button clicked, role: ${myRole}, socket: ${!!socket}`);
    if (socket && myRole === "DM") {
      const msg: ClientToServer = { t: "redo" };
      console.log(`[CLIENT] Sending redo message:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      hudToast("Только DM может повторять действия");
    }
  });

  function updateDockSelection() {
    const determineGroup = (): string => {
      if (editorMode === "revealFog" || editorMode === "eraseFog") return "fog";
      if (editorMode === "spawnToken" || editorMode === "eraseTokens" || selectedTokenKind) return "characters";
      if (selectedFloorKind || editorMode === "eraseSpace") return "floors";
      if (selectedAssetKind || editorMode === "eraseObjects") return "assets";
      return "cursor";
    };
    const activeGroup = determineGroup();
    dockButtons.forEach((btn) => {
      const group = btn.dataset.group;
      btn.classList.toggle("is-selected", group === activeGroup);
    });
  }

  function updateFogModeUI() {
    const fogModeToggle = document.getElementById("fog-mode-toggle") as HTMLInputElement | null;
    if (fogModeToggle) {
      fogModeToggle.checked = fogMode === "manual";
    }
  }

  function updateEditorUI() {
    const isDM = myRole === "DM";
    
    // Force close any open panels first and remove all open classes
    closeToolPanels();
    
    // Additional cleanup: remove open classes from all panels regardless of visibility
    const allToolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    allToolPanels.forEach(panel => {
      panel.classList.remove("open");
      // Force hide panels that should be hidden
      if (!isDM && (panel.id === 'panel-characters' || panel.id === 'panel-brush' || panel.id === 'panel-fog' || panel.id === 'panel-assets' || panel.id === 'panel-floors')) {
        panel.style.display = 'none';
        panel.classList.remove("open");
      }
    });
    
    const allDockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    allDockButtons.forEach(btn => {
      btn.classList.remove("open");
    });
    
    // Hide/show tool panels based on role
    const toolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    toolPanels.forEach(panel => {
      const panelId = panel.id;
      if (panelId === 'panel-characters') {
        // Characters panel is only for DM
        panel.style.display = isDM ? 'block' : 'none';
      } else if (panelId === 'panel-brush' || panelId === 'panel-fog' || panelId === 'panel-assets' || panelId === 'panel-floors') {
        // These panels are only for DM
        panel.style.display = isDM ? 'block' : 'none';
      }
    });
    
    // Hide/show dock buttons based on role
    const dockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    dockButtons.forEach(btn => {
      const group = btn.getAttribute('data-group');
      if (group === 'characters') {
        // Characters button is only for DM
        btn.style.display = isDM ? 'flex' : 'none';
      } else if (group === 'brush' || group === 'fog' || group === 'assets' || group === 'floors') {
        // These buttons are only for DM
        btn.style.display = isDM ? 'flex' : 'none';
      }
    });
    
    // Disable/enable buttons
    if (btnCursor) btnCursor.disabled = false; // cursor is always available
    if (btnEraseTokens) btnEraseTokens.disabled = !isDM;
    if (btnEraseObjects) btnEraseObjects.disabled = !isDM;
    if (btnEraseSpace) btnEraseSpace.disabled = !isDM;
    if (btnAssetTree) btnAssetTree.disabled = !isDM;
    if (btnAssetRock) btnAssetRock.disabled = !isDM;
    if (btnAssetBush) btnAssetBush.disabled = !isDM;
    if (btnAssetWall) btnAssetWall.disabled = !isDM;
    if (btnAssetWindow) btnAssetWindow.disabled = !isDM;
    if (btnAssetDoor) btnAssetDoor.disabled = !isDM;
    if (btnAssetChest) btnAssetChest.disabled = !isDM;
    if (btnAssetSword) btnAssetSword.disabled = !isDM;
    if (btnAssetBow) btnAssetBow.disabled = !isDM;
    if (btnAssetCoins) btnAssetCoins.disabled = !isDM;
    if (btnAssetOther) btnAssetOther.disabled = !isDM;
    if (btnFloorStone) btnFloorStone.disabled = !isDM;
    if (btnFloorWood) btnFloorWood.disabled = !isDM;
    if (btnFloorWater) btnFloorWater.disabled = !isDM;
    if (btnFloorSand) btnFloorSand.disabled = !isDM;
    if (btnFloorGrass) btnFloorGrass.disabled = !isDM;
    if (btnBrush1) btnBrush1.disabled = !isDM;
    if (btnBrush2) btnBrush2.disabled = !isDM;
    if (btnBrush3) btnBrush3.disabled = !isDM;
    if (btnBrush4) btnBrush4.disabled = !isDM;
    if (btnNewMap) btnNewMap.disabled = !isDM;
    if (btnNewFolder) btnNewFolder.disabled = !isDM;
    if (btnRevealFog) btnRevealFog.disabled = !isDM;
    if (btnEraseFog) btnEraseFog.disabled = !isDM;
    if (btnAddPlayer) btnAddPlayer.disabled = !isDM;
    if (btnAddNPC) btnAddNPC.disabled = !isDM;
    if (btnUndo) btnUndo.disabled = !isDM;
    if (btnRedo) btnRedo.disabled = !isDM;
    
    // Reset editor mode if switching to player role
    if (!isDM && (editorMode === "paint" || editorMode === "eraseObjects" || editorMode === "eraseSpace" || editorMode === "eraseTokens" || editorMode === "spawnToken" || editorMode === "revealFog" || editorMode === "eraseFog")) {
      editorMode = "cursor";
      selectedAssetKind = null;
      selectedFloorKind = null;
      selectedTokenKind = null;
    }
    
    // selected states
    btnEraseTokens?.classList.toggle("selected", editorMode === "eraseTokens");
    btnEraseObjects?.classList.toggle("selected", editorMode === "eraseObjects");
    btnEraseSpace?.classList.toggle("selected", editorMode === "eraseSpace");
    btnAssetTree?.classList.toggle("selected", selectedAssetKind === "tree");
    btnAssetRock?.classList.toggle("selected", selectedAssetKind === "rock");
    btnAssetBush?.classList.toggle("selected", selectedAssetKind === "bush");
    btnAssetWall?.classList.toggle("selected", selectedAssetKind === "wall");
    btnAssetWindow?.classList.toggle("selected", selectedAssetKind === "window");
    btnAssetDoor?.classList.toggle("selected", selectedAssetKind === "door");
    btnAssetChest?.classList.toggle("selected", selectedAssetKind === "chest");
    btnAssetSword?.classList.toggle("selected", selectedAssetKind === "sword");
    btnAssetBow?.classList.toggle("selected", selectedAssetKind === "bow");
    btnAssetCoins?.classList.toggle("selected", selectedAssetKind === "coins");
    btnAssetOther?.classList.toggle("selected", selectedAssetKind === "other");
    btnFloorStone?.classList.toggle("selected", selectedFloorKind === "stone");
    btnFloorWood?.classList.toggle("selected", selectedFloorKind === "wood");
    btnFloorWater?.classList.toggle("selected", selectedFloorKind === "water");
    btnFloorSand?.classList.toggle("selected", selectedFloorKind === "sand");
    btnFloorGrass?.classList.toggle("selected", selectedFloorKind === "grass");
    btnBrush1?.classList.toggle("selected", brushSize === 1);
    btnBrush2?.classList.toggle("selected", brushSize === 2);
    btnBrush3?.classList.toggle("selected", brushSize === 3);
    btnBrush4?.classList.toggle("selected", brushSize === 4);
    btnRevealFog?.classList.toggle("selected", editorMode === "revealFog");
    btnEraseFog?.classList.toggle("selected", editorMode === "eraseFog");
    // Token spawn selection state
    btnAddPlayer?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "player");
    btnAddNPC?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "npc");
    
    updateDockSelection();
    
    // Redraw everything to reflect role changes
    drawFloor();
    drawGrid();
    drawWalls();
    drawObjects();
    drawAssets();
    drawTokens();
    drawFog();
  }

  function updateUndoRedoButtons(undoStack: any[], redoStack: any[]) {
    const isDM = myRole === "DM";
    
    // Update undo button
    if (btnUndo) {
      btnUndo.disabled = !isDM || undoStack.length === 0;
      btnUndo.title = undoStack.length > 0 
        ? `Отменить: ${undoStack[undoStack.length - 1]?.description || "предыдущее действие"}` 
        : "Отменить предыдущее действие";
    }
    
    // Update redo button
    if (btnRedo) {
      btnRedo.disabled = !isDM || redoStack.length === 0;
      btnRedo.title = redoStack.length > 0 
        ? `Повторить: ${redoStack[redoStack.length - 1]?.description || "отмененное действие"}` 
        : "Повторить действие";
    }
  }

  updateEditorUI();
  updateFogModeUI();
  // Editor tool buttons
  btnCursor?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeToolPanels();
    editorMode = "cursor";
    selectedAssetKind = null;
    selectedFloorKind = null;
    selectedTokenKind = null;
    updateEditorUI();
  });
  btnEraseTokens?.addEventListener("click", () => { 
    editorMode = "eraseTokens"; 
    selectedAssetKind = null; 
    selectedFloorKind = null; 
    selectedTokenKind = null;
    document.body.style.cursor = "crosshair";
    updateEditorUI(); 
  });
  btnEraseObjects?.addEventListener("click", () => { editorMode = "eraseObjects"; selectedAssetKind = null; selectedFloorKind = null; selectedTokenKind = null; updateEditorUI(); });
  btnEraseSpace?.addEventListener("click", () => { editorMode = "eraseSpace"; selectedAssetKind = null; selectedFloorKind = null; selectedTokenKind = null; updateEditorUI(); });
  btnAssetTree?.addEventListener("click", () => { selectedAssetKind = "tree"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetRock?.addEventListener("click", () => { selectedAssetKind = "rock"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetBush?.addEventListener("click", () => { selectedAssetKind = "bush"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetWall?.addEventListener("click", () => { selectedAssetKind = "wall"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetWindow?.addEventListener("click", () => { selectedAssetKind = "window"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetDoor?.addEventListener("click", () => { selectedAssetKind = "door"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetChest?.addEventListener("click", () => { selectedAssetKind = "chest"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetSword?.addEventListener("click", () => { selectedAssetKind = "sword"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetBow?.addEventListener("click", () => { selectedAssetKind = "bow"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetCoins?.addEventListener("click", () => { selectedAssetKind = "coins"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetOther?.addEventListener("click", () => { selectedAssetKind = "other"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorStone?.addEventListener("click", () => { selectedFloorKind = "stone"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorWood?.addEventListener("click", () => { selectedFloorKind = "wood"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorWater?.addEventListener("click", () => { selectedFloorKind = "water"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorSand?.addEventListener("click", () => { selectedFloorKind = "sand"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorGrass?.addEventListener("click", () => { selectedFloorKind = "grass"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnBrush1?.addEventListener("click", () => { brushSize = 1; updateEditorUI(); });
  btnBrush2?.addEventListener("click", () => { brushSize = 2; updateEditorUI(); });
  btnBrush3?.addEventListener("click", () => { brushSize = 3; updateEditorUI(); });
  btnBrush4?.addEventListener("click", () => { brushSize = 4; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { editorMode = "revealFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnEraseFog?.addEventListener("click", () => { editorMode = "eraseFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { selectedTokenKind = null; });
  btnEraseFog?.addEventListener("click", () => { selectedTokenKind = null; });
  
  // Fog mode toggle handler
  const fogModeToggle = document.getElementById("fog-mode-toggle") as HTMLInputElement | null;
  fogModeToggle?.addEventListener("change", () => {
    if (!socket || myRole !== "DM") return;
    const newMode: FogMode = fogModeToggle.checked ? "manual" : "automatic";
    const msg: ClientToServer = { t: "setFogMode", fogMode: newMode };
    socket.send(JSON.stringify(msg));
  });
  
  btnAddPlayer?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    selectedTokenKind = "player";
    selectedAssetKind = null; selectedFloorKind = null;
    editorMode = "spawnToken";
    document.body.style.cursor = "crosshair";
    updateEditorUI();
  });
  btnAddNPC?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    selectedTokenKind = "npc";
    selectedAssetKind = null; selectedFloorKind = null;
    editorMode = "spawnToken";
    document.body.style.cursor = "crosshair";
    updateEditorUI();
  });
  btnNewMap?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    const name = prompt("Название новой карты:", "Новая карта");
    if (name == null) return;
    const levelIdNew: ID = uid("lvl");
    const locationIdNew: ID = uid("loc");
    const seed = `seed-${Date.now().toString(36)}`;
    const snap: GameSnapshot = {
      location: { id: locationIdNew, name: name || "Новая карта", levels: [{ id: levelIdNew, seed, spawnPoint: { x: 5, y: 5 }, lights: [] }] },
      tokens: [],
      assets: [],
      floors: [],
      events: [] as Event[],
    };
    const msg: ClientToServer = { t: "loadSnapshot", snapshot: snap };
    socket.send(JSON.stringify(msg));
    // Immediately persist to disk so it appears in the list
    const slug = (name || "map")
      .replace(/[\\/]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "map";
    const relPath = `${slug}.json`;
    const saveMsg: ClientToServer = { t: "saveLocation", path: relPath };
    socket.send(JSON.stringify(saveMsg));
  });

  btnNewFolder?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    const rel = prompt("Введите путь папки (относительно корня):", "new-folder");
    if (rel == null) return;
    const pathClean = rel.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
    if (!pathClean) return;
    const msg: ClientToServer = { t: "createFolder", path: pathClean };
    socket.send(JSON.stringify(msg));
  });

  function requestLocationsList() {
    if (!socket) return;
    const msg: ClientToServer = { t: "listLocations" };
    socket.send(JSON.stringify(msg));
  }

  function renderLocationsTree(tree: LocationTreeNode[], lastUsed?: string) {
    if (!locationsTreeEl) return;
    locationsTreeEl.innerHTML = "";
    // Build path map for quick lookup (used by Recent)
    try { console.debug(`[LOC][client] renderLocationsTree: treeRoots=${tree.length}, lastUsed=${lastUsed ?? ""}`); } catch {}
    const pathMap = new Map<string, LocationTreeNode>();
    const walk = (n: LocationTreeNode) => { pathMap.set(n.path, n); if (n.children) n.children.forEach(walk); };
    for (const n of tree) walk(n);
    try {
      const hasDemo = Array.from(pathMap.keys()).some((k) => {
        const p = k.toLowerCase();
        return p === "demo-location2.json" || p.endsWith("/demo-location2.json");
      });
      console.debug(`[LOC][client] pathMap size=${pathMap.size}, has demo-location2=${hasDemo}`);
    } catch {}

    // Clean up recent list: remove items not present in tree
    const prevCount = recentLocations.length;
    const cleaned = recentLocations.filter((p) => {
      const lower = p.toLowerCase();
      // Keep demo and test entries now; only require presence in the tree
      return pathMap.has(p);
    });
    try { console.debug(`[LOC][client] recent before=${prevCount}, afterFilter=${cleaned.length}`); } catch {}
    if (cleaned.length !== recentLocations.length) {
      recentLocations = cleaned;
      saveRecents();
    }

    // Recent section (limit to 3)
    if (recentLocations.length) {
      const sec = document.createElement("div");
      const h = document.createElement("div"); h.className = "loc-section-title"; h.textContent = "Recent"; sec.appendChild(h);
      for (const p of recentLocations.slice(0, 3)) {
        const n = pathMap.get(p);
        const baseLabel = n ? (n.locationName ? `${n.locationName} (${n.name})` : n.name) : p;
        const label = baseLabel + (p === lastUsed ? " ★" : "");
        const row = createLocItem(label, "🕘", p === lastUsed);
        row.title = p;
        row.onclick = () => {
          if (!socket || myRole !== "DM") return;
          const msg: ClientToServer = { t: "loadLocation", path: p };
          socket.send(JSON.stringify(msg));
          closeLocations();
          addRecent(p);
        };
        sec.appendChild(row);
      }
      locationsTreeEl.appendChild(sec);
    }

    // All section
    const secAll = document.createElement("div");
    const hAll = document.createElement("div"); hAll.className = "loc-section-title"; hAll.textContent = "All"; secAll.appendChild(hAll);
    for (const node of tree) secAll.appendChild(renderNode(node, 0, lastUsed));
    locationsTreeEl.appendChild(secAll);
  }

  function renderNode(node: LocationTreeNode, depth: number, lastUsed?: string): HTMLElement {
    if (node.type === "folder") {
      const open = locationsExpanded.has(node.path);
      const container = document.createElement("div");
      const row = document.createElement("div");
      row.className = "loc-item";
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const twist = document.createElement("span"); twist.textContent = open ? "▾" : "▸"; twist.className = "twist";
      const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = "📁";
      const name = document.createElement("span"); name.className = "name"; name.textContent = node.name;
      row.appendChild(twist); row.appendChild(icon); row.appendChild(name);
      const spacer = document.createElement("span"); spacer.style.flex = "1"; row.appendChild(spacer);
      // Actions: create subfolder
      const btnAdd = document.createElement("span");
      btnAdd.title = "Новая папка внутри";
      btnAdd.textContent = "+";
      btnAdd.style.opacity = "0.85";
      btnAdd.style.marginLeft = "6px";
      btnAdd.style.userSelect = "none";
      btnAdd.onclick = (e) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        const name = prompt("Название новой папки:", "folder");
        if (!name) return;
        const base = node.path.endsWith("/") ? node.path.slice(0, -1) : node.path;
        const rel = `${base}/${name}`;
        const msg: ClientToServer = { t: "createFolder", path: rel };
        socket.send(JSON.stringify(msg));
      };
      row.appendChild(btnAdd);
      // Action: rename folder (pencil)
      const btnRename = document.createElement("span");
      btnRename.title = "Переименовать папку";
      btnRename.textContent = "✎";
      btnRename.style.opacity = "0.85";
      btnRename.style.marginLeft = "6px";
      btnRename.style.userSelect = "none";
      btnRename.onclick = (e) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        const cur = node.name;
        const nn = prompt("Новое имя папки:", cur || "folder");
        if (!nn) return;
        const newName = nn.replace(/\s+/g, " ").trim();
        if (!newName || /[\\/]/.test(newName)) { alert("Недопустимое имя папки"); return; }
        const msg: ClientToServer = { t: "renameFolder", path: node.path, newName };
        socket.send(JSON.stringify(msg));
      };
      row.appendChild(btnRename);
      const toggle = () => { if (open) locationsExpanded.delete(node.path); else locationsExpanded.add(node.path); requestLocationsList(); };
      row.onclick = toggle; twist.onclick = (e) => { e.stopPropagation(); toggle(); };
      container.appendChild(row);
      if (open && node.children) {
        const childrenWrap = document.createElement("div");
        for (const ch of node.children) childrenWrap.appendChild(renderNode(ch, depth + 1, lastUsed));
        container.appendChild(childrenWrap);
      }
      return container;
    } else {
      const title = node.locationName ? `${node.locationName} (${node.name})` : node.name;
      const row = createLocItem(title + (node.path === lastUsed ? " ★" : ""), "📄", node.path === lastUsed);
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.title = node.path;
      row.onclick = () => {
        if (!socket || myRole !== "DM") return;
        const msg: ClientToServer = { t: "loadLocation", path: node.path };
        socket.send(JSON.stringify(msg));
        closeLocations();
        addRecent(node.path);
      };
      // Inline actions on the right: Move, Delete
      const spacer = document.createElement("span"); spacer.style.flex = "1"; row.appendChild(spacer);
      const mkAction = (label: string, title: string, handler: (e: MouseEvent) => void) => {
        const s = document.createElement("span"); s.textContent = label; s.title = title; s.style.opacity = "0.85"; s.style.marginLeft = "6px"; s.style.userSelect = "none"; s.onclick = handler; return s;
      };
      const onMove = (e: MouseEvent) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        const dest = prompt("Переместить в папку (путь относительно корня, пусто = корень):", "");
        if (dest == null) return;
        const toFolder = dest.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
        const msg: ClientToServer = { t: "moveLocation", from: node.path, toFolder };
        socket.send(JSON.stringify(msg));
      };
      const onDelete = (e: MouseEvent) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        if (!confirm(`Удалить локацию ${title}?`)) return;
        const msg: ClientToServer = { t: "deleteLocation", path: node.path };
        socket.send(JSON.stringify(msg));
      };
      row.appendChild(mkAction("↪", "Переместить", onMove));
      row.appendChild(mkAction("🗑", "Удалить", onDelete));
      return row;
    }
  }

  function createLocItem(label: string, iconChar: string, active?: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "loc-item" + (active ? " active" : "");
    const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = iconChar;
    const name = document.createElement("span"); name.className = "name"; name.textContent = label;
    row.appendChild(icon); row.appendChild(name);
    return row;
  }
  // Update buttons after welcome determines role
  const observer = new MutationObserver(() => { updateEditorUI(); updateFogModeUI(); });
  observer.observe(document.body, { subtree: true, childList: true });
}

connect();

function centerOn(v: Vec2) {
  const s = world.scale.x || 1;
  const pos = { x: v.x * CELL + CELL / 2, y: v.y * CELL + CELL / 2 };
  const cx = app.screen.width / 2 - pos.x * s;
  const cy = app.screen.height / 2 - pos.y * s;
  world.position.set(cx, cy);
  drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog(); drawMinimap();
}

function centerOnMyToken() {
  if (myTokenId) {
    const tok = tokens.get(myTokenId);
    if (tok) { centerOn(tok.pos); return; }
  }
  // Fallback: center on level spawn if available
  if (currentLocation && levelId) {
    const lvl = currentLocation.levels.find(l => l.id === levelId);
    if (lvl) { centerOn(lvl.spawnPoint); return; }
  }
  // Last resort: center on map middle
  centerOn({ x: 5, y: 5 });
}

// ------ Camera: pan (LMB drag on empty space) & zoom (wheel) ------
type PanState = { startX: number; startY: number; worldX: number; worldY: number } | null;
let panning: PanState = null;
// Start panning when pressing on stage background (tokens stopPropagation already)
function isOverMinimap(x: number, y: number) {
  const mx = minimap.position.x, my = minimap.position.y;
  return x >= mx && y >= my && x <= mx + minimapSize && y <= my + minimapSize;
}

app.stage.on("pointerdown", (e: any) => {
  // ignore if token drag already initiated
  if (dragging) return;
  // only left button
  if (typeof e.button === "number" && e.button !== 0) return;
  // ignore clicks over minimap
  if (isOverMinimap(e.global.x, e.global.y)) return;
  const p = world.toLocal(e.global);
  const cell = snapToGrid(p.x, p.y);
  if (myRole === "DM") {
    const brushActive = BRUSH_MODES.includes(editorMode);
    lastPointerDownDidAct = false;
    if (brushActive) {
      document.body.style.cursor = "crosshair";
      painting = true;
      lastPaintKey = null;
      lastPaintCell = null;
      const result = applyBrushAtCell(cell);
      if (result.touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
      if (result.acted) lastPointerDownDidAct = true;
      lastPaintCell = cell;
      lastPaintKey = cellKey(cell);
      e.stopPropagation?.();
      return;
    }
    if (editorMode === "spawnToken") {
      document.body.style.cursor = "crosshair";
      if (socket && levelId && selectedTokenKind) {
        const kind = selectedTokenKind;
        const msg: ClientToServer = { t: "spawnToken", kind, levelId, pos: cell };
        socket.send(JSON.stringify(msg));
        lastPointerDownDidAct = true;
        // reset tool back to cursor after one placement
        selectedTokenKind = null;
        editorMode = "cursor";
        document.body.style.cursor = dragging ? "grabbing" : "default";
      }
      e.stopPropagation?.();
      return;
    }
    painting = false;
    lastPaintCell = null;
    lastPaintKey = null;
  }
  panning = { startX: e.global.x, startY: e.global.y, worldX: world.position.x, worldY: world.position.y };
  document.body.style.cursor = "grabbing";
});
// Fallback for single-click taps to reliably apply 1x1 (and other) brush actions even if pointerdown didn't apply
app.stage.on("pointertap", (e: any) => {
  // If a drag was initiated or click is over minimap, ignore
  if (dragging) return;
  if (isOverMinimap(e.global.x, e.global.y)) return;
  if (myRole !== "DM") return;
  // Only handle paint tool here to avoid duplicating other actions; also avoid duplicates if pointerdown already acted
  if (editorMode !== "paint" || !selectedFloorKind || lastPointerDownDidAct) return;
  const lvlTap = resolveActiveLevel();
  if (!lvlTap) return;
  if (!levelId) levelId = lvlTap;
  const p = world.toLocal(e.global);
  const cell = snapToGrid(p.x, p.y);
  const result = applyBrushAtCell(cell);
  if (result.touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
  if (result.acted) lastPointerDownDidAct = true;
  lastPaintCell = cell;
  lastPaintKey = cellKey(cell);
});
app.stage.on("pointermove", (e: any) => {
  if (painting) {
    const p = world.toLocal(e.global);
    const cell = snapToGrid(p.x, p.y);
    const key = cellKey(cell);
    if (key === lastPaintKey) return;
    const prev = lastPaintCell;
    const steps = prev ? cellsBetween(prev, cell) : [cell];
    if (steps.length === 0) {
      lastPaintCell = cell;
      lastPaintKey = key;
      return;
    }
    let touchedFloor = false;
    let acted = false;
    for (const step of steps) {
      const result = applyBrushAtCell(step);
      if (result.touchedFloor) touchedFloor = true;
      if (result.acted) acted = true;
    }
    if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
    if (acted) lastPointerDownDidAct = true;
    lastPaintCell = cell;
    lastPaintKey = key;
    return;
  }
  if (!panning) return;
  const dx = e.global.x - panning.startX;
  const dy = e.global.y - panning.startY;
  world.position.set(panning.worldX + dx, panning.worldY + dy);
  drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog(); drawMinimap();
});
function endPan() {
  if (painting) {
    painting = false;
    lastPaintKey = null;
    lastPaintCell = null;
    document.body.style.cursor = "default";
  }
  if (!panning) return;
  panning = null;
  document.body.style.cursor = "default";
}
app.stage.on("pointerup", endPan);
app.stage.on("pointerupoutside", endPan);

// Zoom with wheel, focus on cursor
const MIN_ZOOM = 0.5, MAX_ZOOM = 2.5, ZOOM_STEP = 0.1;
const canvasEl: HTMLCanvasElement = (app as any).view || (app as any).canvas;
canvasEl.addEventListener("wheel", (ev) => {
  const isPinchZoom = ev.ctrlKey;
  const deltaMagnitude = Math.hypot(ev.deltaX, ev.deltaY);
  const isTrackpadPan = !isPinchZoom && ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL && deltaMagnitude < 40;
  if (isTrackpadPan) {
    ev.preventDefault();
    world.position.set(world.position.x - ev.deltaX, world.position.y - ev.deltaY);
    drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog(); drawMinimap();
    return;
  }
  ev.preventDefault();
  const oldS = world.scale.x || 1;
  const direction = ev.deltaY !== 0 ? -Math.sign(ev.deltaY) : ev.deltaX !== 0 ? -Math.sign(ev.deltaX) : 0;
  if (!direction) return;
  let s = oldS + direction * ZOOM_STEP;
  s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s));
  if (s === oldS) return;
  const sx = ev.clientX; const sy = ev.clientY;
  // world coords under cursor before zoom
  const wx = (sx - world.position.x) / oldS;
  const wy = (sy - world.position.y) / oldS;
  world.scale.set(s);
  // adjust position so the same world point stays under cursor
  world.position.set(sx - wx * s, sy - wy * s);
  drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog(); drawMinimap();
}, { passive: false });

// ------ Minimap ------
const minimap = new Graphics();
uiLayer.addChild(minimap);
// enable pointer capture for minimap to prevent background panning when interacting with it
// @ts-ignore
minimap.eventMode = "static";
// @ts-ignore
minimap.cursor = "pointer";
minimap.on("pointerdown", (ev: any) => ev.stopPropagation());
let minimapSize = 180; // px
function positionMinimap() {
  const margin = 24;
  let offsetX = margin;
  let offsetY = margin;
  try {
    const rp = document.getElementById("right-panel");
    if (rp) {
      const rect = rp.getBoundingClientRect();
      const vw = window.innerWidth || app.screen.width;
      const vh = window.innerHeight || app.screen.height;
      if (rect.right + margin > vw) {
        offsetX = Math.max(offsetX, rect.right + margin - vw);
      }
      if (rect.bottom + margin > vh) {
        offsetY = Math.max(offsetY, rect.bottom + margin - vh);
      }
    }
  } catch {}
  minimap.position.set(app.screen.width - minimapSize - offsetX, app.screen.height - minimapSize - offsetY);
}
positionMinimap();
window.addEventListener("resize", positionMinimap);

function drawMinimap() {
  minimap.clear();
  const s = world.scale.x || 1;
  // Compute camera center tile
  const camWX = (-world.position.x) / s + app.screen.width / (2 * s);
  const camWY = (-world.position.y) / s + app.screen.height / (2 * s);
  const camGX = Math.floor(camWX / CELL);
  const camGY = Math.floor(camWY / CELL);
  // Region around camera
  const regionTiles = 60; // tiles across
  const half = Math.floor(regionTiles / 2);
  const startGX = camGX - half;
  const startGY = camGY - half;
  const scale = minimapSize / regionTiles;
  // Background
  minimap.rect(0, 0, minimapSize, minimapSize).fill({ color: 0x0b0e13, alpha: 0.9 }).stroke({ color: 0x111827, width: 2 });
  // Highlight ground tiles based on existing floors
  for (let j = 0; j < regionTiles; j++) {
    for (let i = 0; i < regionTiles; i++) {
      const gx = startGX + i; const gy = startGY + j;
      if (!isGround(gx, gy)) continue;
      const x = i * scale, y = j * scale;
      minimap.rect(x, y, scale, scale).fill({ color: 0x374151, alpha: 0.25 });
    }
  }
  // Walls (sampled like main, but masked to ground tiles)
  const seed = currentSeed || "demo-seed"; const hs = hashString(seed);
  const wallColor = 0x374151;
  for (let j = 0; j <= regionTiles; j++) {
    for (let i = 0; i <= regionTiles; i++) {
      const gx = startGX + i; const gy = startGY + j;
      const h = hash2D(gx, gy, hs);
      if ((h & 0x1f) === 0 && isGround(gx, gy) && isGround(gx, gy - 1)) {
        const x0 = i * scale, y0 = j * scale;
        minimap.moveTo(x0, y0).lineTo(x0 + scale, y0).stroke({ color: wallColor, width: 1 });
      }
      if (((h >>> 5) & 0x1f) === 0 && isGround(gx, gy) && isGround(gx - 1, gy)) {
        const x0 = i * scale, y0 = j * scale;
        minimap.moveTo(x0, y0).lineTo(x0, y0 + scale).stroke({ color: wallColor, width: 1 });
      }
    }
  }
  // Tokens
  for (const t of tokens.values()) {
    const rx = (t.pos.x - startGX + 0.5) * scale;
    const ry = (t.pos.y - startGY + 0.5) * scale;
    if (rx < 0 || ry < 0 || rx > minimapSize || ry > minimapSize) continue;
    minimap.circle(rx, ry, Math.max(2, scale * 0.2)).fill(t.id === myTokenId ? 0x8ab4f8 : 0x9aa0a6);
  }
  // Viewport rectangle
  const vb = getVisibleBounds();
  const vx = (vb.startGX - startGX) * scale;
  const vy = (vb.startGY - startGY) * scale;
  const vw = vb.tilesX * scale;
  const vh = vb.tilesY * scale;
  minimap.rect(vx, vy, vw, vh).stroke({ color: 0xffffff, width: 1, alpha: 0.8 });
}
