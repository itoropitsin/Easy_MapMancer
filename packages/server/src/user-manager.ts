import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import type { User, UserRole, LoginRequest, CreateUserRequest } from '@dnd/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_DB_PATH = path.join(__dirname, '../data/users.json');

export class UserManager {
  private users: Map<string, User> = new Map();
  private sessions: Map<string, string> = new Map(); // token -> userId

  constructor() {
    this.loadUsers();
  }

  needsFirstUser(): boolean {
    return this.users.size === 0;
  }

  private normalizeUsername(value: string): string {
    return value.trim();
  }

  private normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  private findByUsernameOrEmail(usernameOrEmail: string): User | undefined {
    const needle = usernameOrEmail.trim().toLowerCase();
    return Array.from(this.users.values()).find(u =>
      u.username.trim().toLowerCase() === needle || u.email.trim().toLowerCase() === needle
    );
  }

  private isUsernameTaken(username: string, excludeUserId?: string): boolean {
    const normalized = this.normalizeUsername(username).toLowerCase();
    return Array.from(this.users.values()).some(u =>
      u.id !== excludeUserId && u.username.trim().toLowerCase() === normalized
    );
  }

  private isEmailTaken(email: string, excludeUserId?: string): boolean {
    const normalized = this.normalizeEmail(email);
    return Array.from(this.users.values()).some(u =>
      u.id !== excludeUserId && u.email.trim().toLowerCase() === normalized
    );
  }

  private loadUsers(): void {
    try {
      console.log('Loading users from:', USERS_DB_PATH);
      console.log('File exists:', fs.existsSync(USERS_DB_PATH));
      if (fs.existsSync(USERS_DB_PATH)) {
        const data = fs.readFileSync(USERS_DB_PATH, 'utf8');
        console.log('Raw file data:', data);
        const usersArray: User[] = JSON.parse(data);
        console.log('Parsed users array:', usersArray);
        this.users = new Map(usersArray.map(user => [user.id, user]));
        console.log('Users map size before deduplication:', this.users.size);
        this.deduplicateUsers();
        console.log('Users map size after deduplication:', this.users.size);
      } else {
        console.log('Users file does not exist, creating empty database');
        // Create empty users database if it doesn't exist
        this.createEmptyUsersDatabase();
      }
    } catch (error) {
      console.error('Error loading users:', error);
      // Create empty database on error
      this.createEmptyUsersDatabase();
    }
  }

  private deduplicateUsers(): void {
    console.log('Starting deduplication with', this.users.size, 'users');
    const byUsername = new Set<string>();
    const byEmail = new Set<string>();
    let changed = false;
    for (const [id, user] of Array.from(this.users.entries())) {
      const normalizedUsername = this.normalizeUsername(user.username ?? "");
      const normalizedEmail = this.normalizeEmail(user.email ?? "");
      const usernameKey = normalizedUsername.toLowerCase();
      const emailKey = normalizedEmail.toLowerCase();
      console.log(`Checking user ${id}: username="${usernameKey}", email="${emailKey}"`);
      if (byUsername.has(usernameKey) || byEmail.has(emailKey)) {
        console.log(`Removing duplicate user ${id}`);
        this.users.delete(id);
        changed = true;
        continue;
      }
      user.username = normalizedUsername;
      user.email = normalizedEmail;
      byUsername.add(usernameKey);
      byEmail.add(emailKey);
    }
    console.log('Deduplication complete. Changed:', changed, 'Remaining users:', this.users.size);
    if (changed) {
      this.saveUsers();
    }
  }

  private createEmptyUsersDatabase(): void {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(USERS_DB_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      // Create empty users array
      const emptyUsers: User[] = [];
      fs.writeFileSync(USERS_DB_PATH, JSON.stringify(emptyUsers, null, 2));
      console.log('Created empty users database at:', USERS_DB_PATH);
    } catch (error) {
      console.error('Error creating empty users database:', error);
    }
  }

  private saveUsers(): void {
    try {
      const usersArray = Array.from(this.users.values());
      fs.writeFileSync(USERS_DB_PATH, JSON.stringify(usersArray, null, 2));
    } catch (error) {
      console.error('Error saving users:', error);
    }
  }

  private invalidateSessionsForUser(userId: string): void {
    for (const [token, uid] of this.sessions.entries()) {
      if (uid === userId) {
        this.sessions.delete(token);
      }
    }
  }

  private generatePassword(): string {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const symbols = '!@#$%^&*';
    const allChars = uppercase + lowercase + digits + symbols;
    const ensureChar = (pool: string) => pool.charAt(Math.floor(Math.random() * pool.length));

    const passwordChars: string[] = [
      ensureChar(uppercase),
      ensureChar(lowercase),
      ensureChar(digits),
      ensureChar(symbols)
    ];

    while (passwordChars.length < 12) {
      passwordChars.push(ensureChar(allChars));
    }

    for (let i = passwordChars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [passwordChars[i], passwordChars[j]] = [passwordChars[j], passwordChars[i]];
    }

    return passwordChars.join('');
  }

  async login(loginData: LoginRequest): Promise<{ success: boolean; user?: User; token?: string; error?: string }> {
    const usernameOrEmail = loginData.usernameOrEmail?.trim() ?? "";
    const password = loginData.password ?? "";

    // Find user by username or email (case-insensitive, trimmed)
    const user = this.findByUsernameOrEmail(usernameOrEmail);

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return { success: false, error: 'Invalid password' };
    }

    // Update last login
    user.lastLoginAt = Date.now();
    this.saveUsers();

    // Create session token
    const token = uuidv4();
    this.sessions.set(token, user.id);

    return { success: true, user, token };
  }

  logout(token: string): boolean {
    return this.sessions.delete(token);
  }

  getUserByToken(token: string): User | undefined {
    const userId = this.sessions.get(token);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  async createUser(userData: CreateUserRequest): Promise<{ success: boolean; user?: User; generatedPassword?: string; error?: string }> {
    const username = this.normalizeUsername(userData.username ?? "");
    const email = this.normalizeEmail(userData.email ?? "");
    const role: UserRole = userData.role === 'master' ? 'master' : 'user';

    if (!username || !email) {
      return { success: false, error: 'Username and email are required' };
    }

    // Check if username or email already exists
    const usernameTaken = this.isUsernameTaken(username);
    const emailTaken = this.isEmailTaken(email);
    if (usernameTaken || emailTaken) {
      return {
        success: false,
        error: usernameTaken ? 'Username already exists' : 'Email already exists'
      };
    }

    const generatedPassword = this.generatePassword();
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    // Re-check uniqueness after hashing to avoid race conditions
    const usernameTakenAgain = this.isUsernameTaken(username);
    const emailTakenAgain = this.isEmailTaken(email);
    if (usernameTakenAgain || emailTakenAgain) {
      return {
        success: false,
        error: usernameTakenAgain ? 'Username already exists' : 'Email already exists'
      };
    }

    const newUser: User = {
      id: uuidv4(),
      username,
      email,
      passwordHash: hashedPassword,
      role,
      createdAt: Date.now()
    };

    this.users.set(newUser.id, newUser);
    this.saveUsers();

    return { success: true, user: newUser, generatedPassword };
  }

  async createFirstUser(userData: CreateUserRequest): Promise<{ success: boolean; user?: User; generatedPassword?: string; error?: string }> {
    // Force role to master for first user
    const firstUserData = { ...userData, role: 'master' as UserRole };
    const result = await this.createUser(firstUserData);
    
    if (result.success) {
      console.log('🎉 First user created successfully!');
      console.log('Username:', result.user?.username);
      console.log('Email:', result.user?.email);
      console.log('Password:', result.generatedPassword);
      console.log('Role: Master');
    }
    
    return result;
  }

  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }

  updateUserRole(userId: string, role: UserRole): boolean {
    if (role !== 'master' && role !== 'user') return false;
    const user = this.users.get(userId);
    if (!user) return false;

    user.role = role;
    this.saveUsers();
    return true;
  }

  async resetUserPassword(userId: string, password?: string): Promise<{ success: boolean; generatedPassword?: string }> {
    const user = this.users.get(userId);
    if (!user) {
      return { success: false };
    }

    const newPassword = password && password.trim().length > 0 ? password.trim() : this.generatePassword();
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.passwordHash = hashedPassword;
    this.saveUsers();

    this.invalidateSessionsForUser(userId);

    return { success: true, generatedPassword: newPassword };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const user = this.users.get(userId);
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const current = currentPassword ?? "";
    const desired = newPassword ?? "";

    if (!current.trim() || !desired.trim()) {
      return { success: false, error: "All password fields are required" };
    }

    if (desired.length < 12) {
      return { success: false, error: "New password must be at least 12 characters long" };
    }

    if (desired === current) {
      return { success: false, error: "New password must be different from the current password" };
    }

    const matches = await bcrypt.compare(current, user.passwordHash);
    if (!matches) {
      return { success: false, error: "Current password is incorrect" };
    }

    const hashedPassword = await bcrypt.hash(desired, 10);
    user.passwordHash = hashedPassword;
    this.saveUsers();

    this.invalidateSessionsForUser(userId);

    return { success: true };
  }

  deleteUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    // Don't allow deleting the last master user
    if (user.role === 'master') {
      const masterUsers = Array.from(this.users.values()).filter(u => u.role === 'master');
      if (masterUsers.length <= 1) {
        return false;
      }
    }

    this.users.delete(userId);
    for (const [token, uid] of this.sessions.entries()) {
      if (uid === userId) {
        this.sessions.delete(token);
      }
    }
    this.saveUsers();
    return true;
  }

  isMasterUser(userId: string): boolean {
    const user = this.users.get(userId);
    return user?.role === 'master' || false;
  }
}
