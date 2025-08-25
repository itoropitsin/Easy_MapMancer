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
        (h & 0x1f) === 0 && isLand(gx, gy) && isLand(gx, gy - 1) &&
        !(myRole !== "DM" && revealed && (!revealed.has(`${gx},${gy}`) && !revealed.has(`${gx},${gy - 1}`)))
      ) {
        const x0 = gx * CELL, y0 = gy * CELL;
        wallsLayer.moveTo(x0, y0).lineTo(x0 + CELL, y0).stroke({ color, width: 2 });
      }
      // left edge
      if (
        ((h >>> 5) & 0x1f) === 0 && isLand(gx, gy) && isLand(gx - 1, gy) &&
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

import { Application, Graphics, Container, Text, Circle } from "pixi.js";

type ID = string;

type Vec2 = { x: number; y: number };

type Token = { id: ID; owner: ID; levelId: ID; kind?: "player" | "npc"; pos: Vec2; name?: string; hp?: number; ac?: number; tint?: number; stats?: Record<string, number>; vision?: { radius?: number; angle?: number } };

type Asset = { id: ID; levelId: ID; pos: Vec2; kind: string; rot?: number; scale?: number; tint?: number };
type FloorKind = "stone" | "wood" | "water" | "sand";

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

type Level = { id: ID; seed: string; spawnPoint: Vec2; lights: any[] };
type Location = { id: ID; name: string; levels: Level[] };

type ServerToClient =
  | { t: "welcome"; playerId: ID; role: "DM" | "PLAYER"; snapshot: { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] } }
  | { t: "statePatch"; events: any[] }
  | { t: "saveData"; snapshot: { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] } }
  | { t: "reset"; snapshot: { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] } }
  | { t: "error"; message: string }
  | { t: "locationsTree"; tree: LocationTreeNode[]; lastUsedPath?: string }
  | { t: "savedOk"; path: string };

type ClientToServer =
  | { t: "join"; name?: string; invite?: string }
  | { t: "moveToken"; tokenId: ID; pos: Vec2; levelId: ID }
  | { t: "spawnToken"; kind: "player" | "npc"; levelId?: ID; pos?: Vec2; owner?: ID }
  | { t: "revealFog"; levelId: ID; cells: Vec2[] }
  | { t: "obscureFog"; levelId: ID; cells: Vec2[] }
  | { t: "placeAsset"; levelId: ID; pos: Vec2; kind: string; rot?: number; scale?: number; tint?: number }
  | { t: "removeAssetAt"; levelId: ID; pos: Vec2 }
  | { t: "removeTokenAt"; levelId: ID; pos: Vec2 }
  | { t: "paintFloor"; levelId: ID; pos: Vec2; kind: FloorKind | null }
  | { t: "requestSave" }
  | { t: "loadSnapshot"; snapshot: { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] } }
  | { t: "listLocations" }
  | { t: "saveLocation"; path: string }
  | { t: "createFolder"; path: string }
  | { t: "deleteLocation"; path: string }
  | { t: "moveLocation"; from: string; toFolder: string }
  | { t: "renameFolder"; path: string; newName: string }
  | { t: "updateToken"; tokenId: ID; patch: Partial<{ name: string; hp: number; ac: number; tint: number; stats: Record<string, number>; vision: { radius?: number; angle?: number } }> }
  | { t: "loadLocation"; path: string };

// minimal copy of server type for client rendering
type LocationTreeNode = { type: "folder" | "file"; name: string; path: string; children?: LocationTreeNode[]; locationName?: string };

const CELL = 32;
let playerId: ID | null = null;
let myTokenId: ID | null = null;
let levelId: ID | null = null;
const tokens = new Map<ID, Token>();
let currentLocation: Location | null = null;
let currentSeed: string | null = null;
let myRole: "DM" | "PLAYER" | null = null;
const revealedByLevel: Map<ID, Set<string>> = new Map();
const assets = new Map<ID, Asset>();
let editorMode: "cursor" | "paint" | "eraseObjects" | "eraseSpace" | "revealFog" | "eraseFog" | "eraseTokens" | "spawnToken" = "cursor";
let selectedTokenId: ID | null = null;
let selectedAssetKind: string | null = null; // when null, floor tools may be used
let selectedFloorKind: FloorKind | null = null;
let selectedTokenKind: "player" | "npc" | null = null;
let painting = false;
let lastPaintKey: string | null = null;
let brushSize: 1 | 2 | 3 | 4 = 1;
let locationsExpanded = new Set<string>();
let lastUsedLocationPath: string | undefined;
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
      // No hard bounds: allow painting anywhere; server validates usage via isLand or painted floors
      cells.push({ x: gx, y: gy });
    }
  }
  return cells;
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

// 10x10 irregular island mask around (0..9, 0..9)
function isLand(gx: number, gy: number): boolean {
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
        const col = ov === "stone" ? 0x6b7280 : ov === "wood" ? 0x8b5a2b : ov === "water" ? 0x3b82f6 : 0xd1b892; // sand
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
window.addEventListener("resize", () => { drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog(); drawMinimap(); positionMinimap(); });

const tokenLayer = new Container();
tokenLayer.zIndex = 500;
world.addChild(tokenLayer);
// place fog layer after token layer (zIndex also ensures ordering)
world.addChild(fogLayer);

// Tokens that the local user can control are drawn above fog
const myTokensLayer = new Container();
myTokensLayer.zIndex = 1100;
world.addChild(myTokensLayer);

// Walls & objects layers
const wallsLayer = new Graphics();
wallsLayer.zIndex = 200;
world.addChild(wallsLayer);
const objectsLayer = new Graphics();
objectsLayer.zIndex = 300;
world.addChild(objectsLayer);
// Assets layer (editable props)
const assetsLayer = new Container();
assetsLayer.zIndex = 400;
world.addChild(assetsLayer);

// Now that layers exist, draw static content
drawWalls();
drawObjects();

let socket: WebSocket | null = null;
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

function sendUpdateToken(tokenId: ID, patch: Partial<{ name: string; hp: number; ac: number; stats: Record<string, number>; vision: { radius?: number; angle?: number }; tint: number }>) {
  if (!socket) return;
  const msg: ClientToServer = { t: "updateToken", tokenId, patch } as any;
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

function drawTokens() {
  tokenLayer.removeChildren();
  myTokensLayer.removeChildren();
  const revealed = levelId ? getRevealed(levelId) : undefined;
  for (const tok of tokens.values()) {
    if (myRole !== "DM" && revealed && tok.id !== myTokenId && !revealed.has(`${tok.pos.x},${tok.pos.y}`)) {
      // hide non-owned tokens in unrevealed cells for player
      continue;
    }
    const node = new Container();
    const body = new Graphics();
    const isMine = tok.id === myTokenId;
    const baseFill = isMine ? 0x8ab4f8 : 0x9aa0a6;
    const isNPC = (tok as any).kind === "npc";
    if (!isNPC) {
      // Player: circle
      body.circle(0, 0, CELL * 0.4).fill(baseFill).stroke({ color: 0x202124, width: 2 });
    } else {
      // NPC: triangle
      const r = CELL * 0.44;
      const h = r * Math.sqrt(3);
      // vertices for upright triangle centered at (0,0)
      const p1 = { x: 0, y: -h / 3 * 2 / 2 }; // adjust to center mass visually
      const p2 = { x: -r * 0.86, y: h / 3 };
      const p3 = { x: r * 0.86, y: h / 3 };
      body.moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).lineTo(p3.x, p3.y).closePath().fill(baseFill).stroke({ color: 0x202124, width: 2 });
    }
    // Apply per-token tint to the shape only
    if (typeof (tok as any).tint === "number") {
      (body as any).tint = (tok as any).tint;
    }
    // Overlay letter label (initial) as separate sibling so it's not affected by shape tint
    const letter = ((tok as any).name && (tok as any).name.trim().length > 0
      ? (tok as any).name.trim()[0]
      : (isNPC ? "N" : "P")).toUpperCase();
    const label = new Text({
      text: letter,
      style: {
        fill: 0xffffff,
        fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto",
        fontSize: Math.floor(CELL * 0.34),
        fontWeight: "700",
        stroke: 0x202124,
        strokeThickness: 2,
      }
    } as any);
    // @ts-ignore Text has anchor in Pixi v8
    (label as any).anchor?.set?.(0.5);
    label.position.set(0, 0);
    // Don't let the label intercept events; we want the whole token to be draggable
    // @ts-ignore
    label.eventMode = "none";
    // Compose node
    // @ts-ignore Container accepts children
    node.addChild(body as any);
    // @ts-ignore Container accepts children
    node.addChild(label as any);
    node.position.set(tok.pos.x * CELL + CELL / 2, tok.pos.y * CELL + CELL / 2);
    // Enlarge hit area slightly to make grabbing easier
    try { (body as any).hitArea = new Circle(0, 0, CELL * 0.5); } catch {}
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
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } } as any;
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      myTokensLayer.addChild(node);
    } else {
      // @ts-ignore
      node.eventMode = "static";
      node.on("pointertap", (e: any) => { 
        e.stopPropagation?.();
        if (editorMode === "eraseTokens" && myRole === "DM" && socket) {
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } } as any;
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      tokenLayer.addChild(node);
    }
  }
}

// Simple character panel renderer. Expects an element with id "right-panel" to exist.
function renderCharacterPanel() {
  const panel = document.getElementById("right-panel");
  if (!panel) return; // panel not present in DOM yet
  const tok = selectedTokenId ? tokens.get(selectedTokenId) : null;
  if (!tok) {
    panel.innerHTML = '<div style="opacity:.7">Нет выбранного токена</div>';
    return;
  }
  const anyTok: any = tok as any;
  const stats = anyTok.stats || {};
  const vr = Math.max(0, Math.min(20, Number(anyTok.vision?.radius ?? 0) || 0));
  const editable = canControl(tok);
  const tintNum: number = (typeof anyTok.tint === "number" ? anyTok.tint : 0x9aa0a6) & 0xffffff;
  const tintHex = `#${tintNum.toString(16).padStart(6, "0")}`;
  panel.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px;">Лист персонажа</div>
    <div style="display:grid; grid-template-columns: 100px 1fr; gap:6px; font-size:13px; align-items:center;">
      <div>Имя</div><div><input id="char-name" type="text" value="${tok.name ?? ''}" placeholder="Имя" style="width:100%" /></div>
      <div>HP</div><div><input id="char-hp" type="number" inputmode="numeric" value="${Number(anyTok.hp ?? '')}" placeholder="0" style="width:100%" /></div>
      <div>AC</div><div><input id="char-ac" type="number" inputmode="numeric" value="${Number(anyTok.ac ?? '')}" placeholder="0" style="width:100%" /></div>
      <div>Цвет</div><div><input id="char-tint" type="color" value="${tintHex}" style="width:100%" /></div>
      <div>STR</div><div><input id="char-str" type="number" inputmode="numeric" value="${Number(stats.str ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>DEX</div><div><input id="char-dex" type="number" inputmode="numeric" value="${Number(stats.dex ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>CON</div><div><input id="char-con" type="number" inputmode="numeric" value="${Number(stats.con ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>INT</div><div><input id="char-int" type="number" inputmode="numeric" value="${Number(stats.int ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>WIS</div><div><input id="char-wis" type="number" inputmode="numeric" value="${Number(stats.wis ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>CHA</div><div><input id="char-cha" type="number" inputmode="numeric" value="${Number(stats.cha ?? '')}" placeholder="-" style="width:100%" /></div>
      <div>Видимость</div><div><input id="char-vision-radius" type="number" inputmode="numeric" min="0" max="20" value="${vr}" style="width:100%" /> <span style="opacity:.7; font-size:12px; margin-left:4px;">радиус (0-20)</span></div>
    </div>
  `;
  // Enable/disable based on permissions
  const q = (sel: string) => panel.querySelector(sel) as HTMLInputElement | null;
  const setDisabled = (el: HTMLInputElement | null) => { if (el) el.disabled = !editable; };
  ["#char-name", "#char-hp", "#char-ac", "#char-tint", "#char-str", "#char-dex", "#char-con", "#char-int", "#char-wis", "#char-cha", "#char-vision-radius"].forEach(id => setDisabled(q(id)));
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
  const tintEl = q("#char-tint");
  tintEl?.addEventListener("change", () => {
    if (!editable) return;
    const hex = (tintEl.value || "").trim();
    const n = parseInt(hex.replace(/^#/, ""), 16);
    if (Number.isFinite(n)) sendUpdateToken(tok.id, { tint: (n & 0xffffff) });
  });
  const statIds: Array<[string, string]> = [["str", "#char-str"], ["dex", "#char-dex"], ["con", "#char-con"], ["int", "#char-int"], ["wis", "#char-wis"], ["cha", "#char-cha"]];
  for (const [k, sel] of statIds) {
    const el = q(sel);
    el?.addEventListener("change", () => { if (!editable) return; const v = parseNum(el, -99, 99); if (v != null) sendUpdateToken(tok.id, { stats: { [k]: v } }); });
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
}

function drawAssets() {
  assetsLayer.removeChildren();
  if (!levelId) return;
  const revealed = getRevealed(levelId);
  // Build occupancy map for structural connections
  const byKey = new Map<string, { kind: string; open?: boolean }>();
  for (const a of assets.values()) {
    if (a.levelId !== levelId) continue;
    if (myRole !== "DM" && !revealed.has(`${a.pos.x},${a.pos.y}`)) continue;
    byKey.set(`${a.pos.x},${a.pos.y}`, { kind: a.kind, open: (a as any).open });
  }
  const isWallLike = (cell: { kind: string; open?: boolean } | undefined) => {
    if (!cell) return false;
    if (cell.kind === "door") return !cell.open; // closed door behaves like wall
    return cell.kind === "wall" || cell.kind === "window";
  };
  for (const a of assets.values()) {
    if (a.levelId !== levelId) continue;
    if (myRole !== "DM" && !revealed.has(`${a.pos.x},${a.pos.y}`)) continue;
    const g = new Graphics();
    if (a.kind === "tree") {
      // trunk
      g.rect(-CELL * 0.08, CELL * 0.05, CELL * 0.16, CELL * 0.25).fill(0x8d6e63);
      // canopy
      g.circle(0, -CELL * 0.1, CELL * 0.35).fill(0x2e7d32).stroke({ color: 0x1b5e20, width: 2 });
    } else if (a.kind === "rock") {
      g.ellipse(0, 0, CELL * 0.28, CELL * 0.2).fill(0x9aa0a6).stroke({ color: 0x606469, width: 2 });
    } else if (a.kind === "bush") {
      g.circle(0, 0, CELL * 0.28).fill(0x1f7a3e).stroke({ color: 0x145c2f, width: 2 });
    } else if (a.kind === "wall") {
      // Dynamic wall: connect to neighbors
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
      // Windows connect/merge similar to walls but with glass style
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
      // Door attaches to nearest wall direction; closed behaves like wall segment; open — rotated leaf
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
        // closed: blocking bar aligned to orientation
        if (horiz && !vert) g.rect(-CELL / 2, -t / 2, CELL, t).fill(col).stroke({ color: stroke, width: 2 });
        else if (vert && !horiz) g.rect(-t / 2, -CELL / 2, t, CELL).fill(col).stroke({ color: stroke, width: 2 });
        else g.rect(-t / 2, -t / 2, t, t).fill(col).stroke({ color: stroke, width: 2 });
      } else {
        // open: a leaf rotated ~45 degrees, length ~0.7 cell
        const w = CELL * 0.7, h = t;
        g.rect(-w / 2, -h / 2, w, h).fill(col).stroke({ color: stroke, width: 2 });
        g.rotation = horiz ? Math.PI / 4 : -Math.PI / 4; // swing depending on orientation
      }
    } else {
      // default marker
      g.rect(-CELL * 0.2, -CELL * 0.2, CELL * 0.4, CELL * 0.4).fill(0xb5651d);
    }
    // position to cell center
    g.position.set(a.pos.x * CELL + CELL / 2, a.pos.y * CELL + CELL / 2);
    if (typeof a.scale === "number") g.scale.set(a.scale);
    if (typeof a.rot === "number") g.rotation = a.rot;
    if (typeof a.tint === "number") g.tint = a.tint;
    // Enable dragging assets in cursor mode for DM
    if (myRole === "DM") {
      // @ts-ignore pixi v8 events
      g.eventMode = "static";
      g.cursor = editorMode === "cursor" ? "grab" : "default";
      g.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        // door toggle takes priority
        if (a.kind === "door" && socket) {
          const msg: ClientToServer = { t: "toggleDoor", assetId: a.id } as any;
          socket.send(JSON.stringify(msg));
          e.stopPropagation?.();
          return;
        }
        const p0 = world.toLocal(e.global);
        const off = { x: g.x - p0.x, y: g.y - p0.y };
        draggingAsset = { assetId: a.id, kind: a.kind, sprite: g, offset: off, from: { ...a.pos } };
        g.cursor = "grabbing";
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
      g.eventMode = "static";
      g.cursor = editorMode === "cursor" ? "pointer" : g.cursor;
      g.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        if (!socket) return;
        const msg: ClientToServer = { t: "toggleDoor", assetId: a.id } as any;
        socket.send(JSON.stringify(msg));
        e.stopPropagation?.();
      });
    }
    assetsLayer.addChild(g);
  }
}

type DraggingAsset = { assetId: ID; kind: string; sprite: Graphics; offset: { x: number; y: number }; from: Vec2 } | null;
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
  const { sprite, from, kind } = draggingAsset;
  const snapped = snapToGrid(sprite.x, sprite.y);
  // revert if invalid
  if (!levelId || !socket) {
    sprite.position.set(from.x * CELL + CELL / 2, from.y * CELL + CELL / 2);
  } else {
    // simulate move: remove at old, place at new
    const msg1: ClientToServer = { t: "removeAssetAt", levelId, pos: from };
    const msg2: ClientToServer = { t: "placeAsset", levelId, pos: snapped, kind };
    socket.send(JSON.stringify(msg1));
    socket.send(JSON.stringify(msg2));
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
        fogTiles.rect(gx * CELL, gy * CELL, CELL, CELL).fill({ color: 0x000000, alpha: 0.3 });
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
  statusEl.textContent = "WS: connecting...";
  mapInfoEl.textContent = "Карта: —";

  const params = new URLSearchParams(location.search);
  const inv = params.get("inv") ?? "pl-local";
  const startPort = Number(params.get("port") || 8080);
  const endPort = Number(params.get("maxPort") || (startPort + 20));
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname;

  let currentPort = startPort;
  let connecting = false;
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const attachHandlers = (ws: WebSocket, port: number) => {
    ws.addEventListener("message", (ev) => {
      const msg: ServerToClient = JSON.parse(ev.data);
      if (msg.t === "welcome") {
        playerId = msg.playerId;
        myRole = msg.role;
        // store location/seed
        currentLocation = msg.snapshot.location;
        // Update HUD map name and URL with location ID
        try {
        (mapInfoEl as HTMLDivElement).textContent = `Карта: ${currentLocation?.name ?? "—"}`;
        if (currentLocation?.id) {
          const url = new URL(window.location.href);
          url.searchParams.set("loc", currentLocation.id);
          history.replaceState(null, "", url.toString());
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
        for (const a of (msg.snapshot as any).assets ?? []) {
          assets.set(a.id, a);
        }
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
      } else if ((msg as any).t === "saveData") {
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
        // Update HUD map name and URL with location ID
        try {
        (mapInfoEl as HTMLDivElement).textContent = `Карта: ${currentLocation?.name ?? "—"}`;
        if (currentLocation?.id) {
          const url = new URL(window.location.href);
          url.searchParams.set("loc", currentLocation.id);
          history.replaceState(null, "", url.toString());
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
          } else if ((e as any).type === "assetPlaced") {
            const a = (e as any).asset as Asset;
            assets.set(a.id, a);
          } else if ((e as any).type === "assetRemoved") {
            const id = (e as any).assetId as ID;
            assets.delete(id);
          } else if ((e as any).type === "floorPainted") {
            const ev = e as any as { levelId: ID; pos: Vec2; kind: FloorKind | null };
            setFloorOverride(ev.levelId, ev.pos, ev.kind ?? null);
          } else if ((e as any).type === "tokenUpdated") {
            const anyE: any = e as any;
            if (anyE.token) {
              const full: any = anyE.token;
              tokens.set(full.id, full);
              if (myRole === "DM") revealByVisionForToken(ws, full as any);
            } else {
              const ev = e as any as { type: string; tokenId: ID; patch: any };
              const t = tokens.get(ev.tokenId);
              if (t) {
                Object.assign(t, ev.patch || {});
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
      } else if ((msg as any).t === "error") {
        // show error toast for server-side failures
        try { hudToast(`Ошибка: ${(msg as any).message || "неизвестная ошибка"}`); } catch {}
      }
    });
    ws.addEventListener("close", (ev) => {
      (statusEl as HTMLDivElement).textContent = "WS: disconnected";
      try { console.warn(`[WS][client] disconnected from :${port} code=${(ev as any)?.code}`); } catch {}
      setTimeout(() => { tryConnectSequence(); }, 1000);
    });
    ws.addEventListener("error", () => { (statusEl as HTMLDivElement).textContent = "WS: error"; });
  };

  async function tryConnectSequence() {
    if (connecting) return;
    connecting = true;
    while (true) {
      const port = currentPort;
      const wsUrl = `${protocol}://${host}:${port}/ws?inv=${encodeURIComponent(inv)}`;
      try { console.debug(`[WS][client] trying ${wsUrl}`); } catch {}
      (statusEl as HTMLDivElement).textContent = `WS: connecting (:${port})...`;
      const ws = new WebSocket(wsUrl);
      socket = ws;
      const opened = await new Promise<boolean>((resolve) => {
        let done = false;
        const ok = () => { if (done) return; done = true; resolve(true); };
        const fail = () => { if (done) return; done = true; resolve(false); };
        ws.addEventListener("open", ok, { once: true } as any);
        ws.addEventListener("error", fail, { once: true } as any);
        ws.addEventListener("close", fail, { once: true } as any);
      });
      if (opened) {
        (statusEl as HTMLDivElement).textContent = "WS: connected";
        try { console.log(`[WS][client] connected on :${port}`); } catch {}
        const joinMsg: ClientToServer = { t: "join", name: "Player", invite: inv } as any;
        ws.send(JSON.stringify(joinMsg));
        attachHandlers(ws, port);
        connecting = false;
        return;
      } else {
        try { console.warn(`[WS][client] failed to connect on :${port}`); } catch {}
        currentPort = port + 1 > endPort ? startPort : (port + 1);
        await delay(500);
      }
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
  const btnNewMap = document.getElementById("btn-new-map") as HTMLButtonElement | null;
  const btnNewFolder = document.getElementById("btn-new-folder") as HTMLButtonElement | null;
  const btnAddPlayer = document.getElementById("btn-add-player") as HTMLButtonElement | null;
  const btnAddNPC = document.getElementById("btn-add-npc") as HTMLButtonElement | null;
  const locationsTreeEl = document.getElementById("locations-tree") as HTMLDivElement | null;
  const btnBrush1 = document.getElementById("brush-1") as HTMLButtonElement | null;
  const btnBrush2 = document.getElementById("brush-2") as HTMLButtonElement | null;
  const btnBrush3 = document.getElementById("brush-3") as HTMLButtonElement | null;
  const btnBrush4 = document.getElementById("brush-4") as HTMLButtonElement | null;
  const btnRevealFog = document.getElementById("btn-tool-reveal-fog") as HTMLButtonElement | null;
  const btnEraseFog = document.getElementById("btn-tool-erase-fog") as HTMLButtonElement | null;

  function updateEditorUI() {
    const isDM = myRole === "DM";
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
    if (btnBrush1) btnBrush1.disabled = !isDM;
    if (btnBrush2) btnBrush2.disabled = !isDM;
    if (btnBrush3) btnBrush3.disabled = !isDM;
    if (btnBrush4) btnBrush4.disabled = !isDM;
    if (btnNewMap) btnNewMap.disabled = !isDM;
    if (btnNewFolder) btnNewFolder.disabled = !isDM;
    if (btnRevealFog) btnRevealFog.disabled = !isDM;
    if (btnEraseFog) btnEraseFog.disabled = !isDM;
    // selected states
    btnCursor?.classList.toggle("selected", editorMode === "cursor");
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
    btnBrush1?.classList.toggle("selected", brushSize === 1);
    btnBrush2?.classList.toggle("selected", brushSize === 2);
    btnBrush3?.classList.toggle("selected", brushSize === 3);
    btnBrush4?.classList.toggle("selected", brushSize === 4);
    btnRevealFog?.classList.toggle("selected", editorMode === "revealFog");
    btnEraseFog?.classList.toggle("selected", editorMode === "eraseFog");
    // Token spawn selection state
    btnAddPlayer?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "player");
    btnAddNPC?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "npc");
    if (btnAddPlayer) btnAddPlayer.disabled = !isDM;
    if (btnAddNPC) btnAddNPC.disabled = !isDM;
  }
  updateEditorUI();
  // Editor tool buttons
  btnCursor?.addEventListener("click", () => { editorMode = "cursor"; selectedAssetKind = null; selectedFloorKind = null; selectedTokenKind = null; updateEditorUI(); });
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
  btnBrush1?.addEventListener("click", () => { brushSize = 1; updateEditorUI(); });
  btnBrush2?.addEventListener("click", () => { brushSize = 2; updateEditorUI(); });
  btnBrush3?.addEventListener("click", () => { brushSize = 3; updateEditorUI(); });
  btnBrush4?.addEventListener("click", () => { brushSize = 4; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { editorMode = "revealFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnEraseFog?.addEventListener("click", () => { editorMode = "eraseFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { selectedTokenKind = null; });
  btnEraseFog?.addEventListener("click", () => { selectedTokenKind = null; });
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
    const snap = {
      location: { id: locationIdNew, name: name || "Новая карта", levels: [{ id: levelIdNew, seed, spawnPoint: { x: 5, y: 5 }, lights: [] }] },
      tokens: [] as any[],
      assets: [] as any[],
      floors: [] as any[],
      events: [] as any[],
    };
    const msg: ClientToServer = { t: "loadSnapshot", snapshot: snap } as any;
    socket.send(JSON.stringify(msg));
    // Immediately persist to disk so it appears in the list
    const slug = (name || "map")
      .replace(/[\\/]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "map";
    const relPath = `${slug}.json`;
    const saveMsg: ClientToServer = { t: "saveLocation", path: relPath } as any;
    socket.send(JSON.stringify(saveMsg));
  });

  btnNewFolder?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    const rel = prompt("Введите путь папки (относительно корня):", "new-folder");
    if (rel == null) return;
    const pathClean = rel.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
    if (!pathClean) return;
    const msg: ClientToServer = { t: "createFolder", path: pathClean } as any;
    socket.send(JSON.stringify(msg));
  });

  function requestLocationsList() {
    if (!socket) return;
    const msg: ClientToServer = { t: "listLocations" } as any;
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
          const msg: ClientToServer = { t: "loadLocation", path: p } as any;
          socket.send(JSON.stringify(msg));
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
        const msg: ClientToServer = { t: "createFolder", path: rel } as any;
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
        const msg: ClientToServer = { t: "renameFolder", path: node.path, newName } as any;
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
        const msg: ClientToServer = { t: "loadLocation", path: node.path } as any;
        socket.send(JSON.stringify(msg));
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
        const msg: ClientToServer = { t: "moveLocation", from: node.path, toFolder } as any;
        socket.send(JSON.stringify(msg));
      };
      const onDelete = (e: MouseEvent) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        if (!confirm(`Удалить локацию ${title}?`)) return;
        const msg: ClientToServer = { t: "deleteLocation", path: node.path } as any;
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
  const observer = new MutationObserver(() => updateEditorUI());
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
  if (myRole === "DM") {
    if (editorMode === "paint" || editorMode === "eraseObjects" || editorMode === "eraseSpace" || 
        editorMode === "revealFog" || editorMode === "eraseFog" || editorMode === "eraseTokens" || editorMode === "spawnToken") {
      document.body.style.cursor = "crosshair";
    } else {
      document.body.style.cursor = dragging ? "grabbing" : "default";
    }
    painting = true;
    lastPaintKey = null;
    // reset action flag for this pointer sequence
    lastPointerDownDidAct = false;
    const p = world.toLocal(e.global);
    const cell = snapToGrid(p.x, p.y);
    const cells = brushCells(cell, brushSize);
    if (editorMode === "paint") {
      if (levelId) {
        let touchedFloor = false;
        for (const c of cells) {
          if (selectedFloorKind) {
            // optimistic local update
            setFloorOverride(levelId, c, selectedFloorKind);
            touchedFloor = true;
            if (socket) {
              const msg: ClientToServer = { t: "paintFloor", levelId, pos: c, kind: selectedFloorKind };
              socket.send(JSON.stringify(msg));
            }
          } else {
            // assets are server-authoritative; only send if socket exists
            if (socket) {
              const kind = selectedAssetKind ?? "tree";
              const msg: ClientToServer = { t: "placeAsset", levelId, pos: c, kind };
              socket.send(JSON.stringify(msg));
            }
          }
        }
        if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
        lastPointerDownDidAct = true;
      }
    } else if (editorMode === "eraseObjects") {
      if (socket && levelId) {
        for (const c of cells) {
          const msg: ClientToServer = { t: "removeAssetAt", levelId, pos: c };
          socket.send(JSON.stringify(msg));
        }
        lastPointerDownDidAct = true;
      }
    } else if (editorMode === "eraseSpace") {
      if (levelId) {
        let touchedFloor = false;
        for (const c of cells) {
          if (socket) {
            const rm: ClientToServer = { t: "removeAssetAt", levelId, pos: c };
            socket.send(JSON.stringify(rm));
          }
          // optimistic local floor removal
          setFloorOverride(levelId, c, null);
          touchedFloor = true;
          if (socket) {
            const fl: ClientToServer = { t: "paintFloor", levelId, pos: c, kind: null };
            socket.send(JSON.stringify(fl));
          }
        }
        if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
        lastPointerDownDidAct = true;
      }
    } else if (editorMode === "revealFog") {
      if (socket && levelId) {
        const msg: ClientToServer = { t: "revealFog", levelId, cells } as any;
        socket.send(JSON.stringify(msg));
        lastPointerDownDidAct = true;
      }
    } else if (editorMode === "eraseFog") {
      if (socket && levelId) {
        const msg: ClientToServer = { t: "obscureFog", levelId, cells } as any;
        socket.send(JSON.stringify(msg));
        lastPointerDownDidAct = true;
      }
    } else if (editorMode === "spawnToken") {
      // place a single token at the clicked cell, then return to cursor mode
      if (socket && levelId && selectedTokenKind) {
        const p = world.toLocal(e.global);
        const cell = snapToGrid(p.x, p.y);
        const msg: ClientToServer = { t: "spawnToken", kind: selectedTokenKind, levelId, pos: cell } as any;
        socket.send(JSON.stringify(msg));
        lastPointerDownDidAct = true;
        // reset tool back to cursor after one placement
        selectedTokenKind = null;
        editorMode = "cursor";
        document.body.style.cursor = dragging ? "grabbing" : "default";
      }
    }
    lastPaintKey = cellKey(cell);
    e.stopPropagation?.();
    return;
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
  if (!levelId) return;
  const p = world.toLocal(e.global);
  const cell = snapToGrid(p.x, p.y);
  const cells = brushCells(cell, brushSize);
  let touchedFloor = false;
  for (const c of cells) {
    setFloorOverride(levelId, c, selectedFloorKind);
    touchedFloor = true;
    if (socket) {
      const msg: ClientToServer = { t: "paintFloor", levelId, pos: c, kind: selectedFloorKind };
      socket.send(JSON.stringify(msg));
    }
  }
  if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
});
app.stage.on("pointermove", (e: any) => {
  if (painting) {
    const p = world.toLocal(e.global);
    const cell = snapToGrid(p.x, p.y);
    const key = cellKey(cell);
    if (key !== lastPaintKey) {
      const cells = brushCells(cell, brushSize);
      if (editorMode === "paint") {
        if (levelId) {
          let touchedFloor = false;
          for (const c of cells) {
            if (selectedFloorKind) {
              // optimistic local update
              setFloorOverride(levelId, c, selectedFloorKind);
              touchedFloor = true;
              if (socket) {
                const msg: ClientToServer = { t: "paintFloor", levelId, pos: c, kind: selectedFloorKind };
                socket.send(JSON.stringify(msg));
              }
            } else {
              // assets are server-authoritative; only send if socket exists
              if (socket) {
                const kind = selectedAssetKind ?? "tree";
                const msg: ClientToServer = { t: "placeAsset", levelId, pos: c, kind };
                socket.send(JSON.stringify(msg));
              }
            }
          }
          if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
        }
      } else if (editorMode === "eraseObjects") {
        if (socket && levelId) {
          for (const c of cells) {
            const msg: ClientToServer = { t: "removeAssetAt", levelId, pos: c };
            socket.send(JSON.stringify(msg));
          }
        }
      } else if (editorMode === "eraseSpace") {
        if (levelId) {
          let touchedFloor = false;
          for (const c of cells) {
            if (socket) {
              const rm: ClientToServer = { t: "removeAssetAt", levelId, pos: c };
              socket.send(JSON.stringify(rm));
            }
            // optimistic local floor removal
            setFloorOverride(levelId, c, null);
            touchedFloor = true;
            if (socket) {
              const fl: ClientToServer = { t: "paintFloor", levelId, pos: c, kind: null };
              socket.send(JSON.stringify(fl));
            }
          }
          if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
        }
      } else if (editorMode === "revealFog") {
        if (socket && levelId) {
          const msg: ClientToServer = { t: "revealFog", levelId, cells } as any;
          socket.send(JSON.stringify(msg));
        }
      } else if (editorMode === "eraseFog") {
        if (socket && levelId) {
          const msg: ClientToServer = { t: "obscureFog", levelId, cells } as any;
          socket.send(JSON.stringify(msg));
        }
      }
      lastPaintKey = key;
    }
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
  ev.preventDefault();
  const oldS = world.scale.x || 1;
  let s = oldS + (-Math.sign(ev.deltaY)) * ZOOM_STEP;
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
  // Keep minimap fully visible: shift left by right panel width (if present)
  let rightInset = 12;
  try {
    const rp = document.getElementById("right-panel");
    if (rp) {
      const w = Math.ceil(rp.getBoundingClientRect().width);
      // include an extra small gap between panel and minimap
      rightInset += w + 12;
    }
  } catch {}
  minimap.position.set(app.screen.width - minimapSize - rightInset, app.screen.height - minimapSize - 12);
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
  // Light land tiles for the 10x10 island
  for (let j = 0; j < regionTiles; j++) {
    for (let i = 0; i < regionTiles; i++) {
      const gx = startGX + i; const gy = startGY + j;
      if (!isLand(gx, gy)) continue;
      const x = i * scale, y = j * scale;
      minimap.rect(x, y, scale, scale).fill({ color: 0x374151, alpha: 0.25 });
    }
  }
  // Walls (sampled like main, but masked to land)
  const seed = currentSeed || "demo-seed"; const hs = hashString(seed);
  const wallColor = 0x374151;
  for (let j = 0; j <= regionTiles; j++) {
    for (let i = 0; i <= regionTiles; i++) {
      const gx = startGX + i; const gy = startGY + j;
      const h = hash2D(gx, gy, hs);
      if ((h & 0x1f) === 0 && isLand(gx, gy) && isLand(gx, gy - 1)) {
        const x0 = i * scale, y0 = j * scale;
        minimap.moveTo(x0, y0).lineTo(x0 + scale, y0).stroke({ color: wallColor, width: 1 });
      }
      if (((h >>> 5) & 0x1f) === 0 && isLand(gx, gy) && isLand(gx - 1, gy)) {
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
