import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
const PORT = Number(process.env.PORT || 8080);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve data directory robustly for both dev (tsx) and build (dist):
// 1) LOCATIONS_DIR env
// 2) ../data/locations relative to compiled file
// 3) ../../data/locations (if running from nested dist path)
function resolveDataRoot() {
    const fromEnv = process.env.LOCATIONS_DIR;
    if (fromEnv && fromEnv.trim())
        return path.resolve(fromEnv);
    const candidates = [
        path.resolve(__dirname, "../data/locations"),
        path.resolve(__dirname, "../../data/locations"),
    ];
    for (const p of candidates) {
        try {
            // statSync avoids needing async before first use; will throw if not exists
            const st = statSync(p);
            if (st && st.isDirectory())
                return p;
        }
        catch { }
    }
    // fallback to first candidate
    return candidates[0];
}
const DATA_ROOT = resolveDataRoot();
const LAST_USED_FILE = path.resolve(DATA_ROOT, "last-used.json");
function applySnapshot(snap) {
    const payload = snap;
    const loc = payload.location;
    // replace state with defensive defaults so legacy saves still load
    state.location = (loc && typeof loc === "object" && Array.isArray(loc.levels))
        ? loc
        : makeDefaultLocation();
    state.tokens.clear();
    const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    for (const t of tokens) {
        if (!t || !t.id)
            continue;
        state.tokens.set(t.id, t);
    }
    state.assets.clear();
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    for (const a of assets) {
        if (!a || !a.id)
            continue;
        state.assets.set(a.id, a);
    }
    console.log(`[SERVER] applySnapshot: clearing fog, current fog levels: ${state.fog.size}`);
    state.fog.clear();
    // rebuild fog from snapshot events if present
    const events = Array.isArray(payload.events) ? payload.events : [];
    console.log(`[SERVER] Loading snapshot with ${events.length} events`);
    for (const e of events) {
        if (e.type === "fogRevealed") {
            const s = getFogSet(e.levelId);
            console.log(`[SERVER] Restoring fog for level ${e.levelId}, ${e.cells.length} cells`);
            for (const c of e.cells)
                s.add(cellKey(c));
        }
    }
    console.log(`[SERVER] applySnapshot: after restoration, fog levels: ${state.fog.size}`);
    state.floors.clear();
    const floors = Array.isArray(payload.floors)
        ? payload.floors
        : [];
    for (const f of floors) {
        if (!f?.levelId || !f.pos)
            continue;
        let m = state.floors.get(f.levelId);
        if (!m) {
            m = new Map();
            state.floors.set(f.levelId, m);
        }
        m.set(`${f.pos.x},${f.pos.y}`, f.kind);
    }
    const addedFloors = ensureDefaultFloorsForAllLevels();
    if (addedFloors.length > 0) {
        const existing = new Set(Array.isArray(payload.floors)
            ? payload.floors.map((f) => `${f.levelId}:${f.pos.x},${f.pos.y}`)
            : []);
        const merged = Array.isArray(payload.floors)
            ? payload.floors.slice()
            : [];
        for (const f of addedFloors) {
            const key = `${f.levelId}:${f.pos.x},${f.pos.y}`;
            if (existing.has(key))
                continue;
            existing.add(key);
            merged.push({ levelId: f.levelId, pos: { ...f.pos }, kind: f.kind });
        }
        payload.floors = merged;
    }
    // Auto-reveal fog for player tokens after loading
    const isAutomaticMode = !state.location?.fogMode || state.location.fogMode === "automatic";
    if (isAutomaticMode) {
        console.log(`[SERVER] Auto-revealing fog for player tokens in automatic mode`);
        for (const token of state.tokens.values()) {
            const isNPC = token.kind === "npc";
            if (!isNPC) {
                const vr = Math.max(0, Math.min(20, Math.round(token.vision?.radius ?? 0)));
                if (vr > 0) {
                    const fog = getFogSet(token.levelId);
                    const cells = cellsInRadius(token.pos, vr);
                    console.log(`[SERVER] Auto-revealing fog for token ${token.id} at (${token.pos.x}, ${token.pos.y}), ${cells.length} cells`);
                    for (const c of cells) {
                        const k = cellKey(c);
                        if (!fog.has(k)) {
                            fog.add(k);
                        }
                    }
                }
            }
        }
    }
}
const DEFAULT_FLOOR_KIND = "stone";
const DEFAULT_FLOOR_WIDTH = 10;
const DEFAULT_FLOOR_HEIGHT = 10;
function ensureDefaultFloorsForLevel(levelId) {
    let map = state.floors.get(levelId);
    if (!map) {
        map = new Map();
        state.floors.set(levelId, map);
    }
    const added = [];
    for (let y = 0; y < DEFAULT_FLOOR_HEIGHT; y++) {
        for (let x = 0; x < DEFAULT_FLOOR_WIDTH; x++) {
            const key = `${x},${y}`;
            if (map.has(key))
                continue;
            map.set(key, DEFAULT_FLOOR_KIND);
            added.push({ levelId, pos: { x, y }, kind: DEFAULT_FLOOR_KIND });
        }
    }
    return added;
}
function ensureDefaultFloorsForAllLevels() {
    const added = [];
    for (const lvl of state.location.levels) {
        added.push(...ensureDefaultFloorsForLevel(lvl.id));
    }
    return added;
}
function makeDefaultLevel() {
    return {
        id: "L1",
        seed: "seed-1",
        spawnPoint: { x: 5, y: 5 },
        lights: []
    };
}
function makeDefaultLocation() {
    return {
        id: "LOC1",
        name: "Demo Location",
        levels: [makeDefaultLevel()],
        settings: {}
    };
}
const state = {
    location: makeDefaultLocation(),
    tokens: new Map(),
    clients: new Map(),
    fog: new Map(),
    assets: new Map(),
    floors: new Map(),
    undoRedo: {
        undoStack: [],
        redoStack: [],
        maxStackSize: 50
    }
};
ensureDefaultFloorsForAllLevels();
// Current file path for autosave (relative to DATA_ROOT)
let currentSavePath = null;
// ---- Persistence helpers ----
async function ensureDataRoot() {
    await fs.mkdir(DATA_ROOT, { recursive: true });
}
function withinDataRoot(rel) {
    const target = path.resolve(DATA_ROOT, rel);
    if (!target.startsWith(path.resolve(DATA_ROOT) + path.sep))
        return null;
    return target;
}
async function readJSON(file) {
    // Read as UTF-8 string and strip a possible UTF-8 BOM which would break JSON.parse
    let buf = await fs.readFile(file, "utf8");
    if (buf && buf.charCodeAt(0) === 0xfeff)
        buf = buf.slice(1);
    try {
        return JSON.parse(buf);
    }
    catch (e) {
        // Attempt to salvage by trimming any trailing garbage after the first complete JSON value
        try {
            const end = findEndOfFirstJSONValue(buf);
            if (end != null && end > 0) {
                const trimmed = buf.slice(0, end).trimEnd();
                const parsed = JSON.parse(trimmed);
                try {
                    console.warn(`[LOC][server] readJSON: trailing content trimmed for ${path.relative(DATA_ROOT, file)} keptChars=${end}/${buf.length}`);
                }
                catch { }
                return parsed;
            }
        }
        catch { }
        throw e;
    }
}
// Find the end index (exclusive) of the first complete JSON value in a string.
// Handles objects/arrays, strings with escapes, and nesting. Returns null if not found.
function findEndOfFirstJSONValue(s) {
    let i = 0;
    const n = s.length;
    // skip leading whitespace
    while (i < n && /\s/.test(s[i]))
        i++;
    if (i >= n)
        return null;
    const start = i;
    const ch = s[i];
    // For primitives, JSON.parse would succeed or fail differently; we care about object/array roots
    if (ch !== '{' && ch !== '[')
        return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < n; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) {
                esc = false;
                continue;
            }
            if (c === '\\') {
                esc = true;
                continue;
            }
            if (c === '"') {
                inStr = false;
                continue;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{' || c === '[') {
            depth++;
            continue;
        }
        if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) {
                i++;
                break;
            }
            continue;
        }
    }
    if (depth !== 0)
        return null;
    // include trailing whitespace after the value
    while (i < n && /\s/.test(s[i]))
        i++;
    return i;
}
async function writeJSON(file, obj) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}
async function tryReadLastUsed() {
    try {
        const data = await readJSON(LAST_USED_FILE);
        if (!data?.path)
            return null;
        const safe = withinDataRoot(data.path);
        return safe ? data.path : null;
    }
    catch {
        return null;
    }
}
async function writeLastUsed(relPath) {
    await writeJSON(LAST_USED_FILE, { path: relPath });
}
async function buildLocationsTree() {
    const seenLocationIds = new Set();
    async function walk(dirRel) {
        const dirAbs = withinDataRoot(dirRel) ?? DATA_ROOT;
        const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
        const folders = [];
        const files = [];
        for (const ent of entries) {
            if (ent.name.startsWith("."))
                continue;
            if (ent.isDirectory()) {
                const children = await walk(path.join(dirRel, ent.name));
                folders.push({ type: "folder", name: ent.name, path: path.join(dirRel, ent.name) + path.sep, children });
            }
            else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) {
                if (ent.name === "last-used.json")
                    continue; // hide internal meta file if present
                const rel = path.join(dirRel, ent.name);
                const fileAbs = withinDataRoot(rel);
                try {
                    console.debug(`[LOC][server] scanning file: ${rel}`);
                }
                catch { }
                let locationName;
                let locationId;
                let include = false;
                try {
                    const snap = await readJSON(fileAbs);
                    const loc = snap?.location;
                    const hasValidLocation = !!loc && typeof loc.name === "string" && typeof loc.id === "string" && Array.isArray(loc.levels);
                    if (hasValidLocation) {
                        locationName = loc.name;
                        locationId = loc.id;
                        // Check for duplicate location IDs
                        if (seenLocationIds.has(locationId)) {
                            console.warn(`[LOC][server] Duplicate location ID detected: ${locationId} in file ${rel}. Skipping duplicate.`);
                            continue;
                        }
                        seenLocationIds.add(locationId);
                        include = true;
                    }
                }
                catch (e) {
                    try {
                        // Inspect first few bytes to detect encoding/BOM issues
                        let firstBytes = "";
                        try {
                            const raw = await fs.readFile(fileAbs);
                            firstBytes = Array.from(raw.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
                        }
                        catch { }
                        console.warn(`[LOC][server] failed to parse JSON: ${rel} err=${e?.message ?? e} firstBytes=[${firstBytes}]`);
                    }
                    catch { }
                }
                if (include) {
                    files.push({ type: "file", name: ent.name.replace(/\.json$/i, ""), path: rel, locationName });
                    try {
                        console.debug(`[LOC][server] include file: ${rel} (name="${locationName}", id="${locationId}")`);
                    }
                    catch { }
                }
                else {
                    try {
                        console.debug(`[LOC][server] skip file: ${rel} (no valid location)`);
                    }
                    catch { }
                }
            }
        }
        folders.sort((a, b) => a.name.localeCompare(b.name, "en"));
        files.sort((a, b) => a.name.localeCompare(b.name, "en"));
        return [...folders, ...files];
    }
    return walk("");
}
function roleFromInvite(inv) {
    console.log(`[SERVER] roleFromInvite: inv=${inv}`);
    // Always return DM as default, ignore invite codes for now
    console.log(`[SERVER] roleFromInvite: returning DM (default)`);
    return "DM";
}
function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}
function broadcast(events) {
    console.log(`[SERVER] Broadcasting ${events.length} events to ${state.clients.size} clients:`, events.map(e => e.type));
    for (const c of state.clients.values()) {
        send(c.socket, { t: "statePatch", events });
    }
}
// Undo/Redo system functions
function createGameSnapshot() {
    const floors = [];
    for (const [levelId, floorMap] of state.floors) {
        for (const [posKey, kind] of floorMap) {
            const [x, y] = posKey.split(',').map(Number);
            floors.push({ levelId, pos: { x, y }, kind });
        }
    }
    // Include fog state in events
    const events = [];
    console.log(`[SERVER] createGameSnapshot: saving fog for ${state.fog.size} levels`);
    for (const [levelId, fogSet] of state.fog.entries()) {
        const cells = Array.from(fogSet).map((k) => {
            const [xs, ys] = k.split(",");
            return { x: Number(xs), y: Number(ys) };
        });
        console.log(`[SERVER] createGameSnapshot: level ${levelId} has ${cells.length} revealed cells`);
        if (cells.length > 0) {
            events.push({ type: "fogRevealed", levelId, cells });
        }
    }
    console.log(`[SERVER] createGameSnapshot: total events: ${events.length}`);
    return {
        location: state.location,
        tokens: Array.from(state.tokens.values()),
        assets: Array.from(state.assets.values()),
        floors,
        events
    };
}
function createActionSnapshot(actionType, description, beforeState, afterState) {
    return {
        id: randomUUID(),
        timestamp: Date.now(),
        actionType,
        beforeState,
        afterState,
        description
    };
}
function pushToUndoStack(action) {
    const { undoRedo } = state;
    // Clear redo stack when new action is performed
    undoRedo.redoStack = [];
    // Add to undo stack
    undoRedo.undoStack.push(action);
    // Maintain max stack size
    if (undoRedo.undoStack.length > undoRedo.maxStackSize) {
        undoRedo.undoStack.shift();
    }
    console.log(`[SERVER] Added action to undo stack: ${action.description}, stack size: ${undoRedo.undoStack.length}`);
    // Notify clients about undo/redo state
    broadcastUndoRedoState();
}
function performUndo() {
    const { undoRedo } = state;
    console.log(`[SERVER] performUndo called, stack size: ${undoRedo.undoStack.length}`);
    if (undoRedo.undoStack.length === 0) {
        console.log(`[SERVER] performUndo: no actions to undo`);
        return false;
    }
    const action = undoRedo.undoStack.pop();
    console.log(`[SERVER] performUndo: undoing action: ${action.description}`);
    // Apply the before state
    applySnapshot(action.beforeState);
    // Move to redo stack
    undoRedo.redoStack.push(action);
    // Send events for all updated objects
    const events = [];
    // Send asset updates for all assets
    for (const asset of state.assets.values()) {
        events.push({ type: "assetUpdated", asset });
    }
    // Send token updates for all tokens
    for (const token of state.tokens.values()) {
        events.push({ type: "tokenUpdated", token });
    }
    // Notify clients
    broadcastUndoRedoState();
    broadcast([{ type: "undoPerformed", actionId: action.id }]);
    if (events.length > 0) {
        broadcast(events);
    }
    // Send game state restored event to refresh client display
    console.log(`[SERVER] Sending gameStateRestored to ${state.clients.size} clients after undo`);
    for (const client of state.clients.values()) {
        console.log(`[SERVER] Sending gameStateRestored to client ${client.id}`);
        send(client.socket, { t: "gameStateRestored" });
    }
    console.log(`[SERVER] performUndo: completed, redo stack size: ${undoRedo.redoStack.length}`);
    return true;
}
function performRedo() {
    const { undoRedo } = state;
    if (undoRedo.redoStack.length === 0) {
        return false;
    }
    const action = undoRedo.redoStack.pop();
    // Apply the after state
    applySnapshot(action.afterState);
    // Move back to undo stack
    undoRedo.undoStack.push(action);
    // Send events for all updated objects
    const events = [];
    // Send asset updates for all assets
    for (const asset of state.assets.values()) {
        events.push({ type: "assetUpdated", asset });
    }
    // Send token updates for all tokens
    for (const token of state.tokens.values()) {
        events.push({ type: "tokenUpdated", token });
    }
    // Notify clients
    broadcastUndoRedoState();
    broadcast([{ type: "redoPerformed", actionId: action.id }]);
    if (events.length > 0) {
        broadcast(events);
    }
    // Send game state restored event to refresh client display
    console.log(`[SERVER] Sending gameStateRestored to ${state.clients.size} clients after redo`);
    for (const client of state.clients.values()) {
        console.log(`[SERVER] Sending gameStateRestored to client ${client.id}`);
        send(client.socket, { t: "gameStateRestored" });
    }
    return true;
}
function broadcastUndoRedoState() {
    console.log(`[SERVER] Broadcasting undoRedoState to ${state.clients.size} clients: undo=${state.undoRedo.undoStack.length}, redo=${state.undoRedo.redoStack.length}`);
    for (const c of state.clients.values()) {
        send(c.socket, {
            t: "undoRedoState",
            undoStack: state.undoRedo.undoStack,
            redoStack: state.undoRedo.redoStack
        });
    }
}
function clearUndoRedoHistory() {
    state.undoRedo.undoStack = [];
    state.undoRedo.redoStack = [];
    broadcastUndoRedoState();
}
function persistIfAutosave() {
    if (!currentSavePath)
        return;
    (async () => {
        try {
            const safe = withinDataRoot(currentSavePath);
            if (!safe)
                return;
            const { snapshot: snap } = snapshot();
            await writeJSON(safe, snap);
        }
        catch (e) {
            // ignore autosave errors for now
        }
    })();
}
function onMessage(client, data) {
    let msg;
    try {
        msg = JSON.parse(String(data));
    }
    catch (e) {
        return send(client.socket, { t: "error", message: "Invalid JSON" });
    }
    if (!msg || typeof msg !== "object" || !("t" in msg))
        return;
    switch (msg.t) {
        case "join": {
            // Handle role preference from client
            const preferredRole = msg.preferredRole;
            if (preferredRole === "DM" || preferredRole === "PLAYER") {
                client.role = preferredRole;
                console.log(`[SERVER] Client ${client.id} joined with preferred role: ${preferredRole}`);
            }
            break;
        }
        case "ping": {
            send(client.socket, { t: "pong" });
            break;
        }
        case "spawnToken": {
            if (client.role !== "DM")
                return;
            const kind = msg.kind === "npc" ? "npc" : "player";
            const level = msg.levelId || state.location.levels[0]?.id || "L1";
            const basePos = msg.pos || state.location.levels[0]?.spawnPoint || { x: 5, y: 5 };
            ensureDefaultFloorsForLevel(level);
            const levelFloors = state.floors.get(level);
            const parseKey = (key) => {
                const [sx, sy] = key.split(",");
                return { x: Number.parseInt(sx, 10) || 0, y: Number.parseInt(sy, 10) || 0 };
            };
            let pos = { x: Math.floor(basePos.x), y: Math.floor(basePos.y) };
            if (!hasFloorAt(level, pos)) {
                const spawn = state.location.levels.find((lvl) => lvl.id === level)?.spawnPoint ?? { x: 5, y: 5 };
                if (hasFloorAt(level, spawn)) {
                    pos = { x: Math.floor(spawn.x), y: Math.floor(spawn.y) };
                }
                else if (levelFloors && levelFloors.size > 0) {
                    const firstIter = levelFloors.keys().next();
                    if (!firstIter.done && typeof firstIter.value === "string") {
                        pos = parseKey(firstIter.value);
                    }
                    else {
                        return;
                    }
                }
                else {
                    return;
                }
            }
            function occupied(p) {
                for (const t of state.tokens.values()) {
                    if (t.levelId === level && t.pos.x === p.x && t.pos.y === p.y)
                        return true;
                }
                return false;
            }
            if (occupied(pos)) {
                const dirs = [
                    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
                    { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
                ];
                for (const d of dirs) {
                    const p = { x: pos.x + d.x, y: pos.y + d.y };
                    if (!hasFloorAt(level, p))
                        continue;
                    if (!occupied(p)) {
                        pos = p;
                        break;
                    }
                }
            }
            // Create snapshot before action
            const beforeState = createGameSnapshot();
            const owner = msg.owner || client.id;
            const t = kind === "npc" ? makeNPCToken(owner, level, pos) : makePlayerToken(owner, level, pos);
            state.tokens.set(t.id, t);
            // Create snapshot after action and push to undo stack
            const afterState = createGameSnapshot();
            const action = createActionSnapshot("spawnToken", `Creating ${kind === "npc" ? "NPC" : "player"} at (${pos.x}, ${pos.y})`, beforeState, afterState);
            pushToUndoStack(action);
            broadcast([{ type: "tokenSpawned", token: t }]);
            persistIfAutosave();
            break;
        }
        case "moveToken": {
            const tok = state.tokens.get(msg.tokenId);
            if (!tok)
                return;
            if (client.role !== "DM" && tok.owner !== client.id)
                return;
            // Create snapshot before action (only for DM moves)
            const beforeState = client.role === "DM" ? createGameSnapshot() : null;
            // Normalize target to integer grid
            const target = { x: Math.floor(msg.pos.x), y: Math.floor(msg.pos.y) };
            ensureDefaultFloorsForLevel(msg.levelId);
            if (!hasFloorAt(msg.levelId, target))
                return;
            const pos = target;
            tok.pos = pos;
            tok.levelId = msg.levelId;
            const events = [];
            events.push({ type: "tokenMoved", tokenId: tok.id, pos, levelId: tok.levelId });
            // Auto-reveal fog based on token's vision radius, but ONLY for player tokens and ONLY in automatic mode
            const isNPC = tok.kind === "npc";
            const isAutomaticMode = !state.location?.fogMode || state.location.fogMode === "automatic";
            if (!isNPC && isAutomaticMode) {
                const vr = Math.max(0, Math.min(20, Math.round(tok.vision?.radius ?? 0)));
                if (vr > 0) {
                    const fog = getFogSet(tok.levelId);
                    const cells = cellsInRadius(tok.pos, vr);
                    const added = [];
                    for (const c of cells) {
                        const k = cellKey(c);
                        if (!fog.has(k)) {
                            fog.add(k);
                            added.push({ x: c.x, y: c.y });
                        }
                    }
                    if (added.length > 0)
                        events.push({ type: "fogRevealed", levelId: tok.levelId, cells: added });
                }
            }
            // Create snapshot after action and push to undo stack (only for DM moves)
            if (beforeState && client.role === "DM") {
                const afterState = createGameSnapshot();
                const action = createActionSnapshot("moveToken", `Moving token to (${pos.x}, ${pos.y})`, beforeState, afterState);
                pushToUndoStack(action);
            }
            broadcast(events);
            persistIfAutosave();
            break;
        }
        case "updateToken": {
            const tok = state.tokens.get(msg.tokenId);
            if (!tok)
                break;
            // Only DM or token owner can update
            if (client.role !== "DM" && tok.owner !== client.id)
                break;
            const patch = msg.patch;
            // Apply whitelisted fields
            if (typeof patch.name === "string")
                tok.name = String(patch.name).slice(0, 64);
            if (typeof patch.hp === "number")
                tok.hp = Math.max(0, Math.min(999, Math.round(patch.hp)));
            if (typeof patch.ac === "number")
                tok.ac = Math.max(0, Math.min(50, Math.round(patch.ac)));
            if (typeof patch.tint === "number")
                tok.tint = patch.tint >>> 0;
            if (patch.stats && typeof patch.stats === "object") {
                tok.stats = { ...(tok.stats ?? {}), ...patch.stats };
                // sanitize numeric stats if present
                const keys = ["str", "dex", "con", "int", "wis", "cha", "hp", "ac"];
                for (const k of keys) {
                    const v = tok.stats[k];
                    if (typeof v === "number")
                        tok.stats[k] = Math.max(0, Math.min(999, Math.round(v)));
                }
            }
            if (typeof patch.notes === "string") {
                tok.notes = patch.notes.slice(0, 2000);
            }
            else if (patch.notes === null) {
                delete tok.notes;
            }
            if (typeof patch.dead === "boolean") {
                tok.dead = patch.dead;
            }
            if (patch.vision && typeof patch.vision === "object") {
                const vr = Math.max(0, Math.min(20, Math.round(patch.vision.radius ?? (tok.vision?.radius ?? 8))));
                const ang = patch.vision.angle ?? (tok.vision?.angle ?? 360);
                tok.vision = { radius: vr, angle: ang };
            }
            if (typeof patch.icon === "string") {
                tok.icon = patch.icon;
            }
            state.tokens.set(tok.id, tok);
            broadcast([{ type: "tokenUpdated", token: tok }]);
            persistIfAutosave();
            break;
        }
        case "reorderToken": {
            // Only DM or token owner can reorder
            const tok = state.tokens.get(msg.tokenId);
            if (!tok)
                break;
            if (client.role !== "DM" && tok.owner !== client.id)
                break;
            // For top/bottom: compare with all objects on level (assets + tokens)
            // For up/down: compare only with objects at same position
            // Determine new zIndex based on direction
            let newZIndex;
            switch (msg.direction) {
                case "top": {
                    // Move to highest zIndex + 1 (considering all objects on level)
                    const allAssetsOnLevel = Array.from(state.assets.values())
                        .filter(a => a.levelId === tok.levelId);
                    const allTokensOnLevel = Array.from(state.tokens.values())
                        .filter(t => t.levelId === tok.levelId);
                    const maxAssetZ = allAssetsOnLevel.length > 0
                        ? Math.max(...allAssetsOnLevel.map(a => a.zIndex ?? 0))
                        : 0;
                    const maxTokenZ = allTokensOnLevel.length > 0
                        ? Math.max(...allTokensOnLevel.map(t => t.zIndex ?? 0))
                        : 0;
                    newZIndex = Math.max(maxAssetZ, maxTokenZ) + 1;
                    break;
                }
                case "bottom": {
                    // Move to lowest zIndex - 1 (considering all objects on level)
                    const allAssetsOnLevel = Array.from(state.assets.values())
                        .filter(a => a.levelId === tok.levelId);
                    const allTokensOnLevel = Array.from(state.tokens.values())
                        .filter(t => t.levelId === tok.levelId);
                    const minAssetZ = allAssetsOnLevel.length > 0
                        ? Math.min(...allAssetsOnLevel.map(a => a.zIndex ?? 0))
                        : 0;
                    const minTokenZ = allTokensOnLevel.length > 0
                        ? Math.min(...allTokensOnLevel.map(t => t.zIndex ?? 0))
                        : 0;
                    newZIndex = Math.min(minAssetZ, minTokenZ) - 1;
                    break;
                }
                case "up":
                case "down": {
                    // For relative moves, only consider tokens at same position
                    const tokensAtPos = Array.from(state.tokens.values())
                        .filter(t => t.levelId === tok.levelId && t.pos.x === tok.pos.x && t.pos.y === tok.pos.y)
                        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
                    if (tokensAtPos.length <= 1)
                        break; // Nothing to swap with
                    const currentIdx = tokensAtPos.findIndex(t => t.id === tok.id);
                    if (currentIdx === -1)
                        break;
                    if (msg.direction === "up") {
                        // Swap with token above (higher zIndex)
                        if (currentIdx < tokensAtPos.length - 1) {
                            const above = tokensAtPos[currentIdx + 1];
                            newZIndex = above.zIndex ?? 0;
                            above.zIndex = tok.zIndex ?? 0;
                            state.tokens.set(above.id, above);
                            broadcast([{ type: "tokenUpdated", token: above }]);
                        }
                    }
                    else {
                        // Swap with token below (lower zIndex)
                        if (currentIdx > 0) {
                            const below = tokensAtPos[currentIdx - 1];
                            newZIndex = below.zIndex ?? 0;
                            below.zIndex = tok.zIndex ?? 0;
                            state.tokens.set(below.id, below);
                            broadcast([{ type: "tokenUpdated", token: below }]);
                        }
                    }
                    break;
                }
            }
            if (newZIndex !== undefined) {
                tok.zIndex = newZIndex;
                state.tokens.set(tok.id, tok);
                broadcast([{ type: "tokenUpdated", token: tok }]);
                persistIfAutosave();
            }
            break;
        }
        case "reorderAsset": {
            console.log(`[SERVER] reorderAsset received: assetId=${msg.assetId}, direction=${msg.direction}, role=${client.role}`);
            if (client.role !== "DM") {
                console.log(`[SERVER] reorderAsset rejected: not DM`);
                break; // Only DM can reorder assets
            }
            const asset = state.assets.get(msg.assetId);
            if (!asset) {
                console.log(`[SERVER] reorderAsset rejected: asset not found. Looking for: ${msg.assetId}`);
                console.log(`[SERVER] Available asset IDs:`, Array.from(state.assets.keys()).slice(0, 5));
                break;
            }
            console.log(`[SERVER] reorderAsset: asset found at (${asset.pos.x}, ${asset.pos.y}), current zIndex=${asset.zIndex ?? 'undefined'}`);
            // For top/bottom: compare with all objects on level (assets + tokens)
            // For up/down: compare only with objects at same position
            // Determine new zIndex based on direction
            let newZIndex;
            switch (msg.direction) {
                case "top": {
                    // Move to highest zIndex + 1 (considering all objects on level)
                    const allAssetsOnLevel = Array.from(state.assets.values())
                        .filter(a => a.levelId === asset.levelId);
                    const allTokensOnLevel = Array.from(state.tokens.values())
                        .filter(t => t.levelId === asset.levelId);
                    const maxAssetZ = allAssetsOnLevel.length > 0
                        ? Math.max(...allAssetsOnLevel.map(a => a.zIndex ?? 0))
                        : 0;
                    const maxTokenZ = allTokensOnLevel.length > 0
                        ? Math.max(...allTokensOnLevel.map(t => t.zIndex ?? 0))
                        : 0;
                    // Both assets and tokens use same zIndex range, so we add to max found
                    newZIndex = Math.max(maxAssetZ, maxTokenZ) + 1;
                    break;
                }
                case "bottom": {
                    // Move to lowest zIndex - 1 (considering all objects on level)
                    const allAssetsOnLevel = Array.from(state.assets.values())
                        .filter(a => a.levelId === asset.levelId);
                    const allTokensOnLevel = Array.from(state.tokens.values())
                        .filter(t => t.levelId === asset.levelId);
                    const minAssetZ = allAssetsOnLevel.length > 0
                        ? Math.min(...allAssetsOnLevel.map(a => a.zIndex ?? 0))
                        : 0;
                    const minTokenZ = allTokensOnLevel.length > 0
                        ? Math.min(...allTokensOnLevel.map(t => t.zIndex ?? 0))
                        : 0;
                    newZIndex = Math.min(minAssetZ, minTokenZ) - 1;
                    break;
                }
                case "up":
                case "down": {
                    // For relative moves, only consider objects at same position
                    const assetsAtPos = Array.from(state.assets.values())
                        .filter(a => a.levelId === asset.levelId && a.pos.x === asset.pos.x && a.pos.y === asset.pos.y)
                        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
                    if (assetsAtPos.length <= 1)
                        break; // Nothing to swap with
                    const currentIdx = assetsAtPos.findIndex(a => a.id === asset.id);
                    if (currentIdx === -1)
                        break;
                    if (msg.direction === "up") {
                        // Swap with asset above (higher zIndex)
                        if (currentIdx < assetsAtPos.length - 1) {
                            const above = assetsAtPos[currentIdx + 1];
                            newZIndex = above.zIndex ?? 0;
                            above.zIndex = asset.zIndex ?? 0;
                            state.assets.set(above.id, above);
                            broadcast([{ type: "assetUpdated", asset: above }]);
                        }
                    }
                    else {
                        // Swap with asset below (lower zIndex)
                        if (currentIdx > 0) {
                            const below = assetsAtPos[currentIdx - 1];
                            newZIndex = below.zIndex ?? 0;
                            below.zIndex = asset.zIndex ?? 0;
                            state.assets.set(below.id, below);
                            broadcast([{ type: "assetUpdated", asset: below }]);
                        }
                    }
                    break;
                }
            }
            if (newZIndex !== undefined) {
                console.log(`[SERVER] reorderAsset: setting zIndex from ${asset.zIndex ?? 'undefined'} to ${newZIndex}`);
                asset.zIndex = newZIndex;
                state.assets.set(asset.id, asset);
                broadcast([{ type: "assetUpdated", asset }]);
                console.log(`[SERVER] reorderAsset: broadcasted assetUpdated event`);
                persistIfAutosave();
            }
            else {
                console.log(`[SERVER] reorderAsset: newZIndex is undefined, no changes made`);
            }
            break;
        }
        case "revealFog": {
            if (client.role !== "DM")
                return;
            // Create snapshot before action
            const beforeSnapshot = createGameSnapshot();
            const levelFog = getFogSet(msg.levelId);
            const added = [];
            for (const c of msg.cells) {
                const k = cellKey(c);
                if (!levelFog.has(k)) {
                    levelFog.add(k);
                    added.push({ x: c.x, y: c.y });
                }
            }
            if (added.length > 0) {
                const ev = { type: "fogRevealed", levelId: msg.levelId, cells: added };
                broadcast([ev]);
                // Create snapshot after action and push to undo stack
                const afterSnapshot = createGameSnapshot();
                const action = createActionSnapshot("revealFog", `Revealing fog of war (${added.length} cells)`, beforeSnapshot, afterSnapshot);
                pushToUndoStack(action);
                persistIfAutosave();
            }
            break;
        }
        case "obscureFog": {
            if (client.role !== "DM")
                return;
            // Create snapshot before action
            const beforeSnapshot = createGameSnapshot();
            const levelFog = getFogSet(msg.levelId);
            const removed = [];
            for (const c of msg.cells) {
                const k = cellKey(c);
                if (levelFog.has(k)) {
                    levelFog.delete(k);
                    removed.push({ x: c.x, y: c.y });
                }
            }
            if (removed.length > 0) {
                const ev = { type: "fogObscured", levelId: msg.levelId, cells: removed };
                broadcast([ev]);
                // Create snapshot after action and push to undo stack
                const afterSnapshot = createGameSnapshot();
                const action = createActionSnapshot("obscureFog", `Hiding fog of war (${removed.length} cells)`, beforeSnapshot, afterSnapshot);
                pushToUndoStack(action);
                persistIfAutosave();
            }
            break;
        }
        case "setFogMode": {
            if (client.role !== "DM")
                return;
            if (!state.location)
                return;
            // Create snapshot before action
            const beforeSnapshot = createGameSnapshot();
            state.location.fogMode = msg.fogMode;
            const ev = { type: "fogModeChanged", fogMode: msg.fogMode };
            broadcast([ev]);
            // Create snapshot after action and push to undo stack
            const afterSnapshot = createGameSnapshot();
            const action = createActionSnapshot("setFogMode", `Changing fog mode to ${msg.fogMode === "automatic" ? "automatic" : "manual"}`, beforeSnapshot, afterSnapshot);
            pushToUndoStack(action);
            persistIfAutosave();
            break;
        }
        case "undo": {
            if (client.role !== "DM")
                return;
            console.log(`[SERVER] Received undo request from client ${client.id}`);
            const success = performUndo();
            if (success) {
                persistIfAutosave();
            }
            break;
        }
        case "redo": {
            if (client.role !== "DM")
                return;
            console.log(`[SERVER] Received redo request from client ${client.id}`);
            const success = performRedo();
            if (success) {
                persistIfAutosave();
            }
            break;
        }
        case "placeAsset": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            ensureDefaultFloorsForLevel(msg.levelId);
            if (!hasFloorAtXY(msg.levelId, gx, gy))
                return;
            // Create snapshot before action
            const beforeState = createGameSnapshot();
            // remove existing asset at pos (single asset per cell policy)
            const existingId = findAssetIdAt(msg.levelId, { x: gx, y: gy });
            if (existingId)
                state.assets.delete(existingId);
            const asset = {
                id: "a-" + randomUUID(),
                levelId: msg.levelId,
                pos: { x: gx, y: gy },
                kind: msg.kind,
                rot: msg.rot,
                scale: msg.scale,
                tint: msg.tint,
            };
            state.assets.set(asset.id, asset);
            // Create snapshot after action and push to undo stack
            const afterState = createGameSnapshot();
            const action = createActionSnapshot("placeAsset", `Placing ${msg.kind} at (${gx}, ${gy})`, beforeState, afterState);
            pushToUndoStack(action);
            broadcast([{ type: "assetPlaced", asset }]);
            persistIfAutosave();
            break;
        }
        case "moveAsset": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            ensureDefaultFloorsForLevel(msg.levelId);
            if (!hasFloorAtXY(msg.levelId, gx, gy))
                return;
            const asset = state.assets.get(msg.assetId);
            if (!asset) {
                console.log(`[SERVER] moveAsset rejected: asset not found`);
                break;
            }
            // Create snapshot before action
            const beforeState = createGameSnapshot();
            // remove existing asset at new pos (single asset per cell policy)
            const existingId = findAssetIdAt(msg.levelId, { x: gx, y: gy });
            if (existingId && existingId !== msg.assetId) {
                state.assets.delete(existingId);
            }
            // update asset position
            asset.pos = { x: gx, y: gy };
            asset.levelId = msg.levelId;
            state.assets.set(asset.id, asset);
            // Create snapshot after action and push to undo stack
            const afterState = createGameSnapshot();
            const action = createActionSnapshot("moveAsset", `Moving ${asset.kind} to (${gx}, ${gy})`, beforeState, afterState);
            pushToUndoStack(action);
            broadcast([{ type: "assetUpdated", asset }]);
            console.log(`[SERVER] Asset ${asset.id} moved to (${gx}, ${gy})`);
            persistIfAutosave();
            break;
        }
        case "removeAssetAt": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            // Create snapshot before action
            const beforeState = createGameSnapshot();
            const removed = [];
            for (const [id, a] of state.assets.entries()) {
                if (a.levelId === msg.levelId && a.pos.x === gx && a.pos.y === gy) {
                    state.assets.delete(id);
                    removed.push(id);
                }
            }
            if (removed.length === 0)
                return;
            // Create snapshot after action and push to undo stack
            const afterState = createGameSnapshot();
            const action = createActionSnapshot("removeAssetAt", `Removing objects at (${gx}, ${gy})`, beforeState, afterState);
            pushToUndoStack(action);
            broadcast(removed.map((id) => ({ type: "assetRemoved", assetId: id })));
            persistIfAutosave();
            break;
        }
        case "removeTokenAt": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            const removed = [];
            for (const [id, t] of state.tokens.entries()) {
                if (t.levelId === msg.levelId && t.pos.x === gx && t.pos.y === gy) {
                    state.tokens.delete(id);
                    removed.push(id);
                }
            }
            if (removed.length === 0)
                return;
            broadcast(removed.map((id) => ({ type: "tokenRemoved", tokenId: id })));
            persistIfAutosave();
            break;
        }
        case "toggleDoor": {
            // Allow both DM and players to toggle doors
            const a = state.assets.get(msg.assetId);
            if (!a)
                return;
            if (a.kind !== "door")
                return;
            a.open = !(a.open === true);
            state.assets.set(a.id, a);
            broadcast([{ type: "assetPlaced", asset: a }]);
            persistIfAutosave();
            break;
        }
        case "paintFloor": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            // Create snapshot before action
            const beforeState = createGameSnapshot();
            const key = cellKey({ x: gx, y: gy });
            let level = state.floors.get(msg.levelId);
            if (!level) {
                level = new Map();
                state.floors.set(msg.levelId, level);
            }
            if (msg.kind == null) {
                level.delete(key);
            }
            else {
                level.set(key, msg.kind);
            }
            // Create snapshot after action and push to undo stack
            const afterState = createGameSnapshot();
            const action = createActionSnapshot("paintFloor", `Painting floor at (${gx}, ${gy})`, beforeState, afterState);
            pushToUndoStack(action);
            const ev = { type: "floorPainted", levelId: msg.levelId, pos: { x: gx, y: gy }, kind: msg.kind };
            broadcast([ev]);
            persistIfAutosave();
            break;
        }
        case "requestSave": {
            // anyone can request their own save snapshot; typically DM
            const { snapshot: snap } = snapshot();
            send(client.socket, { t: "saveData", snapshot: snap });
            break;
        }
        case "loadSnapshot": {
            if (client.role !== "DM")
                return;
            const snap = msg.snapshot;
            applySnapshot(snap);
            // Clear undo/redo history when loading new snapshot
            clearUndoRedoHistory();
            (async () => {
                try {
                    await ensureDataRoot();
                    currentSavePath = null; // not yet saved to a file
                    await writeLastUsed(""); // clear last used until explicit save
                }
                catch { }
                // broadcast reset to all clients
                for (const c of state.clients.values())
                    send(c.socket, { t: "reset", snapshot: snap });
                // refresh locations tree for the initiating client
                try {
                    const tree = await buildLocationsTree();
                    const lastUsedPath = await tryReadLastUsed();
                    try {
                        const exists = (nodes) => {
                            for (const n of nodes) {
                                const nn = n;
                                if (nn.type === "file") {
                                    const p = String(nn.path || "").toLowerCase();
                                    if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                        return true;
                                }
                                if (Array.isArray(nn.children) && nn.children.length) {
                                    if (exists(nn.children))
                                        return true;
                                }
                            }
                            return false;
                        };
                        const hasDemo = exists(tree);
                        console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                    }
                    catch { }
                    send(client.socket, { t: "locationsTree", tree, lastUsedPath });
                }
                catch { }
            })();
            break;
        }
        case "loadLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                try {
                    const snap = await readJSON(safe);
                    applySnapshot(snap);
                    currentSavePath = rel;
                    await writeLastUsed(rel);
                    // broadcast reset to all clients
                    for (const c of state.clients.values())
                        send(c.socket, { t: "reset", snapshot: snap });
                    // refresh locations list for the requester
                    const tree = await buildLocationsTree();
                    const lastUsedPath = await tryReadLastUsed();
                    try {
                        const exists = (nodes) => {
                            for (const n of nodes) {
                                const nn = n;
                                if (nn.type === "file") {
                                    const p = String(nn.path || "").toLowerCase();
                                    if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                        return true;
                                }
                                if (Array.isArray(nn.children) && nn.children.length) {
                                    if (exists(nn.children))
                                        return true;
                                }
                            }
                            return false;
                        };
                        const hasDemo = exists(tree);
                        console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                    }
                    catch { }
                    send(client.socket, { t: "locationsTree", tree, lastUsedPath });
                }
                catch {
                    send(client.socket, { t: "error", message: "Failed to load location" });
                }
            })();
            break;
        }
        case "listLocations": {
            (async () => {
                await ensureDataRoot();
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "saveLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                const { snapshot: snap } = snapshot();
                await writeJSON(safe, snap);
                await writeLastUsed(rel);
                currentSavePath = rel;
                send(client.socket, { t: "savedOk", path: rel });
                // optionally refresh list
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "createFolder": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const dirAbs = withinDataRoot(path.join(rel, path.sep));
                if (!dirAbs)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                await fs.mkdir(dirAbs, { recursive: true });
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "deleteLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path;
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                try {
                    await fs.unlink(safe);
                    if (currentSavePath === rel)
                        currentSavePath = null;
                    const last = await tryReadLastUsed();
                    if (last === rel)
                        await writeLastUsed("");
                }
                catch {
                    // ignore
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "moveLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const fromRel = msg.from;
                const toFolderRel = msg.toFolder.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const fromAbs = withinDataRoot(fromRel);
                const toDirAbs = toFolderRel === "" ? DATA_ROOT : withinDataRoot(path.join(toFolderRel, path.sep));
                if (!fromAbs || !toDirAbs)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                await fs.mkdir(toDirAbs, { recursive: true });
                const base = path.basename(fromRel);
                const toRel = path.join(toFolderRel, base);
                const toAbs = withinDataRoot(toRel);
                try {
                    await fs.rename(fromAbs, toAbs);
                    if (currentSavePath === fromRel) {
                        currentSavePath = toRel;
                        await writeLastUsed(toRel);
                    }
                }
                catch (e) {
                    send(client.socket, { t: "error", message: "Failed to move location" });
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "renameFolder": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                // sanitize inputs
                const rel = String(msg.path || "").replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const newName = String(msg.newName || "").replace(/\s+/g, " ").trim();
                if (!rel)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                if (!newName || /[\\/]/.test(newName))
                    return send(client.socket, { t: "error", message: "Invalid new name" });
                const fromAbs = withinDataRoot(rel);
                if (!fromAbs)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                // ensure target exists and is a directory
                try {
                    const st = await fs.stat(fromAbs);
                    if (!st.isDirectory())
                        return send(client.socket, { t: "error", message: "Not a folder" });
                }
                catch {
                    return send(client.socket, { t: "error", message: "Folder not found" });
                }
                const parentRel = path.dirname(rel);
                const toRel = parentRel === "." ? newName : path.join(parentRel, newName);
                const toAbs = withinDataRoot(toRel);
                if (!toAbs)
                    return send(client.socket, { t: "error", message: "Invalid rename target" });
                try {
                    await fs.rename(fromAbs, toAbs);
                    // update currentSavePath and last-used if they reside under renamed directory
                    if (currentSavePath && (currentSavePath === rel || currentSavePath.startsWith(rel + "/"))) {
                        const updated = currentSavePath.replace(rel, toRel);
                        currentSavePath = updated;
                        try {
                            await writeLastUsed(updated);
                        }
                        catch { }
                    }
                }
                catch (e) {
                    return send(client.socket, { t: "error", message: "Failed to rename folder" });
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "renameLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const newName = String(msg.newName || "").replace(/\s+/g, " ").trim();
                if (!newName)
                    return send(client.socket, { t: "error", message: "Invalid location name" });
                // Update current location name
                if (state.location) {
                    state.location.name = newName;
                    // Save the updated location
                    if (currentSavePath) {
                        try {
                            const snap = createGameSnapshot();
                            const fileAbs = withinDataRoot(currentSavePath);
                            if (fileAbs) {
                                await writeJSON(fileAbs, snap);
                                console.log(`[server] renamed location to: ${newName}`);
                            }
                        }
                        catch (e) {
                            console.error("[server] failed to save renamed location:", e);
                            return send(client.socket, { t: "error", message: "Failed to save location" });
                        }
                    }
                    // Broadcast the name change to all clients
                    const broadcastMsg = { t: "locationRenamed", newName };
                    for (const c of state.clients.values()) {
                        send(c.socket, broadcastMsg);
                    }
                }
            })();
            break;
        }
        case "loadLocationById": {
            // Allow any client to load a location by ID
            (async () => {
                await ensureDataRoot();
                const locationId = msg.locationId;
                if (!locationId)
                    return send(client.socket, { t: "error", message: "Location ID required" });
                // Find location file by ID
                const tree = await buildLocationsTree();
                let locationPath = null;
                const findLocation = async (nodes) => {
                    for (const node of nodes) {
                        if (node.type === "file") {
                            // Check if this file contains the location ID
                            const filePath = node.path;
                            const safe = withinDataRoot(filePath);
                            if (safe) {
                                try {
                                    const snap = await readJSON(safe);
                                    if (snap.location?.id === locationId) {
                                        locationPath = filePath;
                                        return true;
                                    }
                                }
                                catch (e) {
                                    // Continue searching
                                }
                            }
                        }
                        if (node.children && await findLocation(node.children)) {
                            return true;
                        }
                    }
                    return false;
                };
                if (!(await findLocation(tree)) || !locationPath) {
                    return send(client.socket, { t: "error", message: "Location not found" });
                }
                const safe = withinDataRoot(locationPath);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                try {
                    const snap = await readJSON(safe);
                    applySnapshot(snap);
                    currentSavePath = locationPath;
                    await writeLastUsed(locationPath);
                    // broadcast reset to all clients
                    for (const c of state.clients.values())
                        send(c.socket, { t: "reset", snapshot: snap });
                    send(client.socket, { t: "savedOk", path: locationPath });
                }
                catch (e) {
                    send(client.socket, { t: "error", message: "Failed to load location" });
                }
            })();
            break;
        }
        case "toggleTokenHidden": {
            if (client.role !== "DM") {
                console.log(`[SERVER] toggleTokenHidden rejected: not DM`);
                break;
            }
            const token = state.tokens.get(msg.tokenId);
            if (!token) {
                console.log(`[SERVER] toggleTokenHidden rejected: token not found`);
                break;
            }
            // Toggle hidden state
            token.hidden = !token.hidden;
            state.tokens.set(token.id, token);
            broadcast([{ type: "tokenUpdated", token }]);
            console.log(`[SERVER] Token ${token.id} hidden state toggled to ${token.hidden}`);
            persistIfAutosave();
            break;
        }
        case "toggleAssetHidden": {
            if (client.role !== "DM") {
                console.log(`[SERVER] toggleAssetHidden rejected: not DM`);
                break;
            }
            console.log(`[SERVER] toggleAssetHidden: looking for assetId=${msg.assetId}`);
            console.log(`[SERVER] Available asset IDs:`, Array.from(state.assets.keys()).slice(0, 10));
            const asset = state.assets.get(msg.assetId);
            if (!asset) {
                console.log(`[SERVER] toggleAssetHidden rejected: asset not found`);
                break;
            }
            // Toggle hidden state
            asset.hidden = !asset.hidden;
            state.assets.set(asset.id, asset);
            broadcast([{ type: "assetUpdated", asset }]);
            console.log(`[SERVER] Asset ${asset.id} hidden state toggled to ${asset.hidden}`);
            persistIfAutosave();
            break;
        }
        case "switchRole": {
            // Allow role switching for any client
            const newRole = msg.role;
            if (newRole === "DM" || newRole === "PLAYER") {
                client.role = newRole;
                send(client.socket, { t: "roleChanged", role: newRole });
                console.log(`[SERVER] Client ${client.id} switched role to ${newRole}`);
            }
            break;
        }
    }
}
function cellKey(v) { return `${v.x},${v.y}`; }
function getFogSet(levelId) {
    let s = state.fog.get(levelId);
    if (!s) {
        s = new Set();
        state.fog.set(levelId, s);
    }
    return s;
}
function cellsInRadius(center, r) {
    const out = [];
    const R = Math.max(0, Math.min(20, Math.round(r || 0)));
    for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy <= R * R)
                out.push({ x: center.x + dx, y: center.y + dy });
        }
    }
    return out;
}
function findAssetIdAt(levelId, pos) {
    for (const [id, a] of state.assets.entries()) {
        if (a.levelId === levelId && a.pos.x === pos.x && a.pos.y === pos.y)
            return id;
    }
    return null;
}
function hasFloorAt(levelId, pos) {
    const m = state.floors.get(levelId);
    if (!m)
        return false;
    return m.has(`${pos.x},${pos.y}`);
}
function hasFloorAtXY(levelId, x, y) {
    const m = state.floors.get(levelId);
    if (!m)
        return false;
    return m.has(`${x},${y}`);
}
// Generate a bright-ish random color (each channel in [128..255])
function randomBrightColor() {
    const ch = () => (128 + Math.floor(Math.random() * 128)) & 0xff;
    return (ch() << 16) | (ch() << 8) | ch();
}
// Available character icons
const CHARACTER_ICONS = {
    players: [
        "🧙", "🧙‍♂️", "🧙‍♀️", "⚔️", "🛡️", "🏹", "🗡️", "🔮", "⚡", "🔥",
        "❄️", "🌊", "🌪️", "🌱", "🌿", "🍀", "🌸", "🌺", "🌻", "🌹",
        "👑", "💎", "⭐", "🌟", "✨", "💫", "🌈", "🦄", "🐉", "🐲",
        "🦅", "🦆", "🦇", "🦉", "🦊", "🦋", "🦌", "🦍", "🦎", "🦏",
        "🦐", "🦑", "🦒", "🦓", "🦔", "🦕", "🦖", "🦗", "🦘", "🦙"
    ],
    npcs: [
        "🧟", "🧟‍♂️", "🧟‍♀️", "👹", "👺", "💀", "☠️", "👻", "🎭", "🎪",
        "🤖", "👽", "👾", "🤡", "👹", "👺", "💀", "☠️", "👻", "🎭",
        "🐺", "🐻", "🐻‍❄️", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵",
        "🙈", "🙉", "🙊", "🐒", "🦍", "🦧", "🐶", "🐕", "🐩", "🐕‍🦺",
        "🐈", "🐈‍⬛", "🐱", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈"
    ]
};
function getRandomIcon(kind) {
    const icons = CHARACTER_ICONS[kind === "npc" ? "npcs" : "players"];
    return icons[Math.floor(Math.random() * icons.length)];
}
function makePlayerToken(playerId, levelId, spawn) {
    return {
        id: "t-" + randomUUID(),
        owner: playerId,
        kind: "player",
        levelId,
        pos: { ...spawn },
        vision: { radius: 8, angle: 360 },
        light: null,
        flags: {},
        name: "Player",
        tint: randomBrightColor(),
        zIndex: 100, // Default above assets
        icon: getRandomIcon("player"),
    };
}
function makeNPCToken(owner, levelId, spawn) {
    return {
        id: "t-" + randomUUID(),
        owner,
        kind: "npc",
        levelId,
        pos: { ...spawn },
        vision: { radius: 8, angle: 360 },
        light: null,
        flags: {},
        name: "NPC",
        tint: randomBrightColor(),
        zIndex: 100, // Default above assets
        icon: getRandomIcon("npc"),
    };
}
function snapshot() {
    ensureDefaultFloorsForAllLevels();
    const events = [];
    console.log(`[SERVER] Creating snapshot, fog levels: ${state.fog.size}`);
    for (const [lvl, set] of state.fog.entries()) {
        const cells = Array.from(set).map((k) => {
            const [xs, ys] = k.split(",");
            return { x: Number(xs), y: Number(ys) };
        });
        console.log(`[SERVER] Saving fog for level ${lvl}, ${cells.length} cells`);
        if (cells.length > 0)
            events.push({ type: "fogRevealed", levelId: lvl, cells });
    }
    // floors as entries for client bootstrap
    const floorsArr = [];
    for (const [lvl, mp] of state.floors.entries()) {
        for (const [k, kind] of mp.entries()) {
            const [xs, ys] = k.split(",");
            floorsArr.push({ levelId: lvl, pos: { x: Number(xs), y: Number(ys) }, kind });
        }
    }
    return { snapshot: { location: state.location, tokens: Array.from(state.tokens.values()), assets: Array.from(state.assets.values()), events, floors: floorsArr } };
}
function onConnection(ws, req) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const invite = url.searchParams.get("inv");
    const role = roleFromInvite(invite);
    const clientId = "p-" + randomUUID();
    const client = { id: clientId, role, socket: ws };
    state.clients.set(clientId, client);
    const levelId = state.location.levels[0].id;
    const spawn = state.location.levels[0].spawnPoint;
    // Do NOT auto-spawn tokens on connect. Tokens are added explicitly via 'spawnToken'.
    // Ensure fog set exists for default level
    getFogSet(levelId);
    // Send welcome with snapshot
    const snap = snapshot();
    console.log(`[SERVER] Sending welcome to ${clientId}, role=${role}, assets count=${snap.snapshot.assets.length}`);
    console.log(`[SERVER] First 5 asset IDs in snapshot:`, snap.snapshot.assets.slice(0, 5).map(a => a.id));
    send(ws, { t: "welcome", playerId: clientId, role, ...snap });
    // Send initial undo/redo state
    send(ws, {
        t: "undoRedoState",
        undoStack: state.undoRedo.undoStack,
        redoStack: state.undoRedo.redoStack
    });
    ws.on("message", (data) => onMessage(client, data));
    ws.on("close", () => {
        state.clients.delete(clientId);
    });
}
async function start() {
    await ensureDataRoot();
    // Log resolved data root for diagnostics
    try {
        console.log(`[server] DATA_ROOT: ${DATA_ROOT}`);
    }
    catch { }
    // Autoload last used location if present
    try {
        const rel = await tryReadLastUsed();
        if (rel) {
            const safe = withinDataRoot(rel);
            if (safe) {
                const snap = await readJSON(safe);
                applySnapshot(snap);
                console.log(`[server] autoloaded location: ${rel}`);
            }
        }
    }
    catch (e) {
        console.warn("[server] autoload skipped:", e);
    }
    const server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("DnD Server is running\n");
    });
    // Port listen with retry: if in use, increment port until a free one is found (bounded range)
    let selectedPort = PORT;
    const maxPort = Number(process.env.MAX_PORT || (PORT + 20));
    let attempts = 0;
    while (true) {
        attempts++;
        try {
            try {
                console.log(`[server] attempting to listen on http://localhost:${selectedPort} (attempt ${attempts})`);
            }
            catch { }
            await new Promise((resolve, reject) => {
                const onListening = () => {
                    server.off("error", onError);
                    resolve();
                };
                const onError = (err) => {
                    server.off("listening", onListening);
                    reject(err);
                };
                server.once("listening", onListening);
                server.once("error", onError);
                server.listen(selectedPort);
            });
            break; // success
        }
        catch (err) {
            if (err && err.code === "EADDRINUSE") {
                try {
                    console.warn(`[server] port ${selectedPort} is in use, trying next...`);
                }
                catch { }
                selectedPort++;
                if (selectedPort > maxPort) {
                    throw new Error(`[server] No free port found in range ${PORT}-${maxPort}`);
                }
                continue;
            }
            throw err; // other errors
        }
    }
    // Only create WebSocket server once HTTP server is bound successfully
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", onConnection);
    wss.on("error", (err) => {
        try {
            console.warn(`[server][wss] error: ${String(err?.message || err)}`);
        }
        catch { }
    });
    console.log(`[server] listening on http://localhost:${selectedPort}`);
}
start();
