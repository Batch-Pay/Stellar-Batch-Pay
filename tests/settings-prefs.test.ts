import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadSettingsPreferences,
  saveSettingsPreferences,
  resetSettingsPreferences,
  type SettingsPreferences,
} from "@/lib/settings-prefs";

const STORAGE_KEY = "batchpay_settings_v1";

// Mock localStorage and window for Node environment
const mockStorage = new Map<string, string>();
global.window = {} as any;
global.localStorage = {
  getItem: (key: string) => mockStorage.get(key) || null,
  setItem: (key: string, value: string) => mockStorage.set(key, value),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
  length: 0,
  key: () => null,
};

describe("settings-prefs", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof window !== "undefined") {
      localStorage.clear();
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (typeof window !== "undefined") {
      localStorage.clear();
    }
  });

  describe("loadSettingsPreferences", () => {
    it("should return default preferences when localStorage is empty", () => {
      const prefs = loadSettingsPreferences();
      expect(prefs).toEqual({
        version: 1,
        defaultNetwork: "testnet",
        defaultAsset: "xlm",
        batchValidation: true,
        completionNotifications: true,
      });
    });

    it("should return default preferences on SSR (window undefined)", () => {
      // Mock window as undefined to simulate SSR
      const originalWindow = global.window;
      // @ts-expect-error - intentionally undefined for SSR test
      delete global.window;

      const prefs = loadSettingsPreferences();
      expect(prefs).toEqual({
        version: 1,
        defaultNetwork: "testnet",
        defaultAsset: "xlm",
        batchValidation: true,
        completionNotifications: true,
      });

      global.window = originalWindow;
    });

    it("should load saved preferences from localStorage", () => {
      const savedPrefs: SettingsPreferences = {
        version: 1,
        defaultNetwork: "mainnet",
        defaultAsset: "usdc",
        batchValidation: false,
        completionNotifications: false,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPrefs));

      const prefs = loadSettingsPreferences();
      expect(prefs).toEqual(savedPrefs);
    });

    it("should migrate preferences from version 0 to version 1", () => {
      const oldPrefs = {
        defaultNetwork: "mainnet",
        defaultAsset: "usdt",
        batchValidation: false,
        // Missing version field and completionNotifications
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(oldPrefs));

      const prefs = loadSettingsPreferences();
      expect(prefs.version).toBe(1);
      expect(prefs.defaultNetwork).toBe("mainnet");
      expect(prefs.defaultAsset).toBe("usdt");
      expect(prefs.batchValidation).toBe(false);
      expect(prefs.completionNotifications).toBe(true); // Default value
    });

    it("should handle corrupt localStorage data gracefully", () => {
      localStorage.setItem(STORAGE_KEY, "invalid json");

      const prefs = loadSettingsPreferences();
      expect(prefs).toEqual({
        version: 1,
        defaultNetwork: "testnet",
        defaultAsset: "xlm",
        batchValidation: true,
        completionNotifications: true,
      });
    });

    it("should merge with defaults for missing fields", () => {
      const partialPrefs = {
        version: 1,
        defaultNetwork: "mainnet",
        // Missing other fields
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(partialPrefs));

      const prefs = loadSettingsPreferences();
      expect(prefs.version).toBe(1);
      expect(prefs.defaultNetwork).toBe("mainnet");
      expect(prefs.defaultAsset).toBe("xlm"); // Default
      expect(prefs.batchValidation).toBe(true); // Default
      expect(prefs.completionNotifications).toBe(true); // Default
    });
  });

  describe("saveSettingsPreferences", () => {
    it("should save preferences to localStorage", () => {
      const prefs: Partial<SettingsPreferences> = {
        defaultNetwork: "mainnet",
        defaultAsset: "usdc",
      };

      saveSettingsPreferences(prefs);

      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).toBeDefined();

      const parsed = JSON.parse(stored!);
      expect(parsed.defaultNetwork).toBe("mainnet");
      expect(parsed.defaultAsset).toBe("usdc");
      expect(parsed.version).toBe(1);
    });

    it("should merge with existing preferences", () => {
      // Save initial preferences
      saveSettingsPreferences({
        defaultNetwork: "mainnet",
        defaultAsset: "usdc",
        batchValidation: false,
      });

      // Update only one field
      saveSettingsPreferences({ defaultAsset: "usdt" });

      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);
      expect(parsed.defaultNetwork).toBe("mainnet"); // Preserved
      expect(parsed.defaultAsset).toBe("usdt"); // Updated
      expect(parsed.batchValidation).toBe(false); // Preserved
    });

    it("should not throw on SSR (window undefined)", () => {
      const originalWindow = global.window;
      // @ts-expect-error - intentionally undefined for SSR test
      delete global.window;

      expect(() => {
        saveSettingsPreferences({ defaultNetwork: "mainnet" });
      }).not.toThrow();

      global.window = originalWindow;
    });

    it("should handle localStorage errors gracefully", () => {
      // Mock localStorage.setItem to throw an error
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error("Storage quota exceeded");
      };

      expect(() => {
        saveSettingsPreferences({ defaultNetwork: "mainnet" });
      }).not.toThrow();

      localStorage.setItem = originalSetItem;
    });
  });

  describe("save/load round-trip", () => {
    it("should preserve all preference fields through save/load cycle", () => {
      const originalPrefs: SettingsPreferences = {
        version: 1,
        defaultNetwork: "mainnet",
        defaultAsset: "usdc",
        batchValidation: false,
        completionNotifications: false,
      };

      saveSettingsPreferences(originalPrefs);
      const loadedPrefs = loadSettingsPreferences();

      expect(loadedPrefs).toEqual(originalPrefs);
    });

    it("should handle partial updates through save/load cycle", () => {
      // Save initial state
      const initialPrefs: SettingsPreferences = {
        version: 1,
        defaultNetwork: "testnet",
        defaultAsset: "xlm",
        batchValidation: true,
        completionNotifications: true,
      };
      saveSettingsPreferences(initialPrefs);

      // Update partial fields
      saveSettingsPreferences({
        defaultNetwork: "mainnet",
        completionNotifications: false,
      });

      // Load and verify
      const loadedPrefs = loadSettingsPreferences();
      expect(loadedPrefs.defaultNetwork).toBe("mainnet");
      expect(loadedPrefs.defaultAsset).toBe("xlm"); // Preserved
      expect(loadedPrefs.batchValidation).toBe(true); // Preserved
      expect(loadedPrefs.completionNotifications).toBe(false); // Updated
    });
  });

  describe("resetSettingsPreferences", () => {
    it("should reset preferences to defaults", () => {
      // Save custom preferences
      saveSettingsPreferences({
        defaultNetwork: "mainnet",
        defaultAsset: "usdc",
        batchValidation: false,
        completionNotifications: false,
      });

      // Reset
      resetSettingsPreferences();

      // Load and verify defaults
      const prefs = loadSettingsPreferences();
      expect(prefs).toEqual({
        version: 1,
        defaultNetwork: "testnet",
        defaultAsset: "xlm",
        batchValidation: true,
        completionNotifications: true,
      });
    });

    it("should not throw on SSR (window undefined)", () => {
      const originalWindow = global.window;
      // @ts-expect-error - intentionally undefined for SSR test
      delete global.window;

      expect(() => {
        resetSettingsPreferences();
      }).not.toThrow();

      global.window = originalWindow;
    });
  });
});
