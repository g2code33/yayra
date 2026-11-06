/**
 * Yayra Floating Browser - Password & Keys Vault (TypeScript Definitions)
 */

export interface SavedCredential {
  id: string;
  kind?: 'password' | 'key';
  origin: string;
  username: string;
  password?: string;
  title?: string;
  createdAt?: number;
  lastUsedAt?: number;
}

export interface PasswordManagerConfig {
  savePasswordsEnabled: boolean;
  autofillEnabled: boolean;
  requirePasskeyToReveal: boolean;
  neverSaveOrigins: string[];
}

export declare class PasswordManager {
  constructor(adapter: any);
  initialize(): Promise<PasswordManager>;
  getConfig(): Promise<PasswordManagerConfig>;
  updateConfig(updates: Partial<PasswordManagerConfig>): Promise<PasswordManagerConfig>;
  addNeverSaveOrigin(origin: string): Promise<boolean>;
  removeNeverSaveOrigin(origin: string): Promise<boolean>;
  shouldOfferToSave(params: {
    origin: string;
    username: string;
    password: string;
    isPrivate?: boolean;
  }): Promise<boolean>;
  shouldPromptToSave(origin: string, isPrivate?: boolean): boolean;
  getAllCredentials(): Promise<SavedCredential[]>;
  getAllKeys(): Promise<SavedCredential[]>;
  getCredentialsForOrigin(origin: string): Promise<SavedCredential[]>;
  saveCredential(params: {
    origin: string;
    username: string;
    password: string;
    title?: string;
    isPrivate?: boolean;
    kind?: 'password' | 'key';
  }): Promise<{ success: boolean; id?: string; kind?: string; origin?: string; username?: string; reason?: string }>;
  saveKey(params: {
    label?: string;
    keyName?: string;
    secret: string;
    isPrivate?: boolean;
  }): Promise<{ success: boolean; id?: string; reason?: string }>;
  updateCredential(id: string, updates: { username?: string; password?: string; title?: string }): Promise<boolean>;
  deleteCredential(id: string): Promise<boolean>;
  clearAllCredentials(): Promise<boolean>;
  normalizeOrigin(urlOrOrigin: string): string;
}
