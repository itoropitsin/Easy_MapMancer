export type ID = string;
export type Role = "DM" | "PLAYER";
export type UserRole = "master" | "user";
export interface User {
    id: ID;
    username: string;
    email: string;
    passwordHash: string;
    role: UserRole;
    createdAt: number;
    lastLoginAt?: number;
}
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
    fogMode?: FogMode;
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
    zIndex?: number;
    hidden?: boolean;
    dead?: boolean;
    icon?: string;
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
    zIndex?: number;
    hidden?: boolean;
}
export type FloorKind = "stone" | "wood" | "water" | "sand" | "grass" | "path" | "bridge" | "carpet" | "marble" | "dirt" | "mud" | "snow" | "ice";
export type FogMode = "automatic" | "manual";
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
    type: "fogModeChanged";
    fogMode: FogMode;
} | {
    type: "assetPlaced";
    asset: Asset;
} | {
    type: "assetUpdated";
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
export interface ActionSnapshot {
    id: string;
    timestamp: number;
    actionType: string;
    beforeState: Partial<GameSnapshot>;
    afterState: Partial<GameSnapshot>;
    description: string;
}
export interface UndoRedoState {
    undoStack: ActionSnapshot[];
    redoStack: ActionSnapshot[];
    maxStackSize: number;
}
export interface HistoryEventChange {
    field: string;
    from?: number | string | boolean | null;
    to?: number | string | boolean | null;
}
export interface HistoryEventDetails {
    targetType?: "token" | "asset" | "location";
    targetId?: ID;
    targetName?: string;
    targetKind?: string;
    targets?: Array<{
        id: ID;
        name?: string;
        kind?: string;
    }>;
    levelId?: ID;
    from?: {
        pos?: Vec2;
        levelId?: ID;
    };
    to?: {
        pos?: Vec2;
        levelId?: ID;
    };
    changes?: HistoryEventChange[];
}
export interface HistoryEvent {
    id: string;
    timestamp: number;
    actionType: string;
    description: string;
    actorId?: ID | null;
    actorName?: string;
    actorRole?: Role;
    actionId?: string;
    details?: HistoryEventDetails;
}
export interface LoginRequest {
    usernameOrEmail: string;
    password: string;
}
export interface LoginResponse {
    success: boolean;
    user?: User;
    token?: string;
    error?: string;
}
export interface CreateUserRequest {
    username: string;
    email: string;
    role?: UserRole;
}
export interface ChangePasswordRequest {
    currentPassword: string;
    newPassword: string;
}
export interface ChangePasswordResponse {
    success: boolean;
    error?: string;
    message?: string;
    forceLogout?: boolean;
}
export interface CreateUserResponse {
    success: boolean;
    user?: User;
    generatedPassword?: string;
    error?: string;
}
export interface UserListResponse {
    users: User[];
}
export interface AuthState {
    isAuthenticated: boolean;
    user?: User;
    token?: string;
}
