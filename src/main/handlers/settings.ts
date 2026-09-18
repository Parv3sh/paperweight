import { ipcMain, shell } from "electron";
import { IPC } from "@shared/ipc";
import { isString } from "@shared/validation";
import { applyAutoLaunch, saveSetting } from "../services/settings";
import { getGlobalSetting, saveGlobalSetting } from "../services/globalSettings";
import { buildAppSettings } from "../services/appSettings";
import { dataLog } from "../utils/log";

export function registerSettingsHandlers(): void {
  // --- App settings ---

  ipcMain.on(IPC.getSettings, (event) => {
    event.returnValue = buildAppSettings();
  });

  ipcMain.handle(IPC.saveSettings, (_event, settings: unknown) => {
    if (!settings || typeof settings !== "object") {
      throw new Error("Invalid settings");
    }
    const s = settings as Record<string, unknown>;
    const changedKeys = Object.keys(s).join(", ");
    dataLog.info(`Settings saved: ${changedKeys}`);

    if (s.autoLaunch !== undefined) {
      if (typeof s.autoLaunch !== "boolean") throw new Error("Invalid autoLaunch");
      saveGlobalSetting("autoLaunch", s.autoLaunch);
    }

    if (s.launchMinimized !== undefined) {
      if (typeof s.launchMinimized !== "boolean") throw new Error("Invalid launchMinimized");
      saveGlobalSetting("launchMinimized", s.launchMinimized);
    }

    if (s.autoLaunch !== undefined || s.launchMinimized !== undefined) {
      const autoLaunch = getGlobalSetting("autoLaunch") ?? false;
      const minimized = getGlobalSetting("launchMinimized") ?? false;
      applyAutoLaunch(autoLaunch, minimized);
    }

    if (s.userName !== undefined) {
      if (typeof s.userName !== "string") throw new Error("Invalid userName");
      saveSetting("userName", s.userName);
    }

    if (s.colorTheme !== undefined) {
      if (s.colorTheme !== "dim" && s.colorTheme !== "silk") {
        throw new Error("Invalid colorTheme");
      }
      saveGlobalSetting("colorTheme", s.colorTheme);
    }
  });

  // --- Shell ---

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    if (!isString(url) || url.trim() === "") return;

    try {
      const parsed = new URL(url);
      if (["https:", "http:", "mailto:"].includes(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL, ignore
    }
  });
}
