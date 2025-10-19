export type ID = string;
export type Role = "DM" | "PLAYER";
export interface Vec2 {
    x: number;
    y: number;
}
export interface Light {
    id: ID;
    pos: Vec2;
    radius: number;
}
export interface Level {
    id: ID;
    seed: string;
    spawnPoint: Vec2;
    lights: Light[];
}
export interface Location {
    id: ID;
    name: string;
    levels: Level[];
    settings?: Record<string, unknown>;
}
export interface Token {
    id: ID;
    owner: ID;
    kind?: "player" | "npc";
    levelId: ID;
    pos: Vec2;
    vision?: {
        radius: number;
        angle?: number;
    };
    light?: {
        radius: number;
    } | null;
    flags?: Record<string, boolean>;
    name?: string;
    hp?: number;
    ac?: number;
    tint?: number;
    stats?: {
        str?: number;
        dex?: number;
        con?: number;
        int?: number;
        wis?: number;
        cha?: number;
        hp?: number;
        ac?: number;
    };
    notes?: string;
}
export interface Asset {
    id: ID;
    levelId: ID;
    pos: Vec2;
    kind: string;
    rot?: number;
    scale?: number;
    tint?: number;
    open?: boolean;
}
export type FloorKind = "stone" | "wood" | "water" | "sand";
export type Event = {
    type: "tokenMoved";
    tokenId: ID;
    pos: Vec2;
    levelId: ID;
} | {
    type: "tokenSpawned";
    token: Token;
} | {
    type: "tokenUpdated";
    token: Token;
} | {
    type: "tokenRemoved";
    tokenId: ID;
} | {
    type: "fogRevealed";
    levelId: ID;
    cells: Vec2[];
} | {
    type: "fogObscured";
    levelId: ID;
    cells: Vec2[];
} | {
    type: "assetPlaced";
    asset: Asset;
} | {
    type: "assetRemoved";
    assetId: ID;
} | {
    type: "floorPainted";
    levelId: ID;
    pos: Vec2;
    kind: FloorKind | null;
};
export interface GameSnapshot {
    location: Location;
    tokens: Token[];
    assets: Asset[];
    floors?: {
        levelId: ID;
        pos: Vec2;
        kind: FloorKind;
    }[];
    events?: Event[];
}
export interface LocationTreeNode {
    type: "folder" | "file";
    name: string;
    path: string;
    children?: LocationTreeNode[];
    locationName?: string;
}
