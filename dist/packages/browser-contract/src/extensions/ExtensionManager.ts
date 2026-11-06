/**
 * Yayra Floating Browser - Extension Manager (TypeScript Definitions)
 */

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  enabled: boolean;
  allowedInPrivate: boolean;
  isBuiltIn?: boolean;
  icon?: string;
  contentScripts?: string[];
}

export declare class ExtensionManager {
  constructor(adapter?: any);
  initialize(): Promise<ExtensionManifest[]>;
  getExtensions(): Promise<ExtensionManifest[]>;
  getExtension(id: string): Promise<ExtensionManifest | null>;
  enableExtension(id: string): Promise<boolean>;
  disableExtension(id: string): Promise<boolean>;
  setAllowedInPrivate(id: string, allowed: boolean): Promise<boolean>;
  installExtension(manifest: Partial<ExtensionManifest>): Promise<ExtensionManifest>;
  uninstallExtension(id: string): Promise<boolean>;
  getActiveContentScripts(url: string, isPrivate?: boolean): Promise<string[]>;
}
