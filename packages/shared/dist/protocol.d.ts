import type { ID, Vec2, Role, GameSnapshot, FloorKind, LocationTreeNode, Token } from "./types";
export type ClientToServer = {
    t: "join";
    name?: string;
    invite?: string;
} | {
    t: "ping";
} | {
    t: "moveToken";
    tokenId: ID;
    pos: Vec2;
    levelId: ID;
} | {
    t: "spawnToken";
    kind: "player" | "npc";
    levelId?: ID;
    pos?: Vec2;
    owner?: ID;
} | {
    t: "removeTokenAt";
    levelId: ID;
    pos: Vec2;
} | {
    t: "revealFog";
    levelId: ID;
    cells: Vec2[];
} | {
    t: "obscureFog";
    levelId: ID;
    cells: Vec2[];
} | {
    t: "placeAsset";
    levelId: ID;
    pos: Vec2;
    kind: string;
    rot?: number;
    scale?: number;
    tint?: number;
} | {
    t: "removeAssetAt";
    levelId: ID;
    pos: Vec2;
} | {
    t: "toggleDoor";
    assetId: ID;
} | {
    t: "paintFloor";
    levelId: ID;
    pos: Vec2;
    kind: FloorKind | null;
} | {
    t: "requestSave";
} | {
    t: "loadSnapshot";
    snapshot: GameSnapshot;
} | {
    t: "listLocations";
} | {
    t: "saveLocation";
    path: string;
} | {
    t: "createFolder";
    path: string;
} | {
    t: "deleteLocation";
    path: string;
} | {
    t: "moveLocation";
    from: string;
    toFolder: string;
} | {
    t: "renameFolder";
    path: string;
    newName: string;
} | {
    t: "loadLocation";
    path: string;
} | {
    t: "updateToken";
    tokenId: ID;
    patch: Partial<Token>;
};
export type ServerToClient = {
    t: "welcome";
    playerId: ID;
    role: Role;
    snapshot: GameSnapshot;
} | {
    t: "pong";
} | {
    t: "statePatch";
    events: any[];
} | {
    t: "saveData";
    snapshot: GameSnapshot;
} | {
    t: "reset";
    snapshot: GameSnapshot;
} | {
    t: "error";
    message: string;
} | {
    t: "locationsTree";
    tree: LocationTreeNode[];
    lastUsedPath?: string;
} | {
    t: "savedOk";
    path: string;
};
