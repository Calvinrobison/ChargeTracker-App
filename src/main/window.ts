/**
 * Window creation and lifecycle.
 *
 * Every window is created with the hardened preferences from `security.ts`,
 * gets the production CSP applied to its own responses, and has navigation,
 * new windows and permissions locked down before it loads anything.
 *
 * Closing the window HIDES it: collection continues in the tray. Quit from the
 * tray menu is the only thing that really stops it.
 */

import { BrowserWindow, session, shell, type Session } from 'electron';
import { join } from 'node:path';

import {
  RENDERER_WEB_PREFERENCES,
  buildContentSecurityPolicy,
  decideNavigation,
  decidePermission,
  rendererFileOrigin,
} from './security.ts';
import type { Logger } from './logger.ts';

export interface WindowManagerOptions {
  readonly isDevelopment: boolean;
  readonly preloadPath: string;
  /** Renderer entry: a dev server URL, or an absolute file path in production. */
  readonly rendererUrl: string | null;
  readonly rendererFile: string | null;
  readonly iconPath: string | null;
  readonly tileOrigins: readonly string[];
  readonly updateOrigins: readonly string[];
  readonly externalOrigins: readonly string[];
  readonly logger: Logger;
  /** Called the first time the window is hidden rather than closed. */
  readonly onFirstHide: () => void;
  readonly onHidden: () => void;
  readonly onShown: () => void;
}

export class WindowManager {
  private readonly options: WindowManagerOptions;
  private window: BrowserWindow | null = null;
  private quitting = false;
  private explainedCloseToTray = false;
  private hiddenSinceMs: number | null = null;

  constructor(options: WindowManagerOptions) {
    this.options = options;
  }

  /** Origins that count as "the application's own document". */
  appOrigins(): string[] {
    const origins: string[] = [];
    if (this.options.rendererUrl) origins.push(new URL(this.options.rendererUrl).origin);
    if (this.options.rendererFile) {
      origins.push(rendererFileOrigin(this.options.rendererFile));
    }
    return origins;
  }

  knownWindowIds(): number[] {
    return this.window && !this.window.isDestroyed() ? [this.window.id] : [];
  }

  /** How long the window has been hidden in the tray, or null if it is visible. */
  hiddenForMs(nowMs = Date.now()): number | null {
    if (!this.window || this.window.isDestroyed()) {
      // No window at all counts as hidden, which is a legitimate safe-install
      // condition after a tray-only launch.
      return this.hiddenSinceMs === null ? nowMs : nowMs - this.hiddenSinceMs;
    }
    if (this.window.isVisible()) return null;
    return this.hiddenSinceMs === null ? 0 : nowMs - this.hiddenSinceMs;
  }

  isForegroundActive(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible();
  }

  /**
   * Applies the CSP and request-level policy to a session.
   *
   * This is done on the session rather than a meta tag so it also covers
   * responses the renderer did not author.
   */
  configureSession(target: Session = session.defaultSession): void {
    const csp = buildContentSecurityPolicy({
      isDevelopment: this.options.isDevelopment,
      tileOrigins: this.options.tileOrigins,
      updateOrigins: this.options.updateOrigins,
      devServerOrigin: this.options.rendererUrl ?? undefined,
    });

    target.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
        },
      });
    });

    // Nothing in the renderer needs a permission, so nothing is granted.
    target.setPermissionRequestHandler((_webContents, permission, callback) => {
      const decision = decidePermission(permission);
      if (!decision.granted) {
        this.options.logger.log('warn', `denied renderer permission request: ${permission}`);
      }
      callback(decision.granted);
    });
    target.setPermissionCheckHandler((_wc, permission) => decidePermission(permission).granted);
  }

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 640,
      show: false,
      backgroundColor: '#0D1412',
      title: 'ChargeWatch',
      autoHideMenuBar: true,
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      webPreferences: {
        ...RENDERER_WEB_PREFERENCES,
        preload: this.options.preloadPath,
      },
    });

    window.removeMenu();

    // Deny unexpected navigation in-window.
    window.webContents.on('will-navigate', (event, url) => {
      const decision = decideNavigation(url, {
        appOrigins: this.appOrigins(),
        externalOrigins: this.options.externalOrigins,
      });
      if (decision.action === 'allow') return;
      event.preventDefault();
      if (decision.action === 'open_externally') {
        void shell.openExternal(decision.url);
        return;
      }
      this.options.logger.log('warn', `blocked navigation to ${url}: ${decision.reason}`);
    });

    // Deny new windows; allowed links go to the system browser instead.
    window.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideNavigation(url, {
        appOrigins: this.appOrigins(),
        externalOrigins: this.options.externalOrigins,
      });
      if (decision.action === 'open_externally') {
        void shell.openExternal(decision.url);
      } else {
        this.options.logger.log(
          'warn',
          `blocked window open for ${url}: ${decision.action === 'deny' ? decision.reason : 'in-window only'}`,
        );
      }
      return { action: 'deny' };
    });

    // A renderer that crashes is reloaded once rather than leaving a blank pane.
    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.log('error', `renderer process gone: ${details.reason}`);
      if (details.reason !== 'clean-exit' && !this.quitting) {
        window.webContents.reload();
      }
    });

    window.on('ready-to-show', () => {
      window.show();
      this.hiddenSinceMs = null;
      this.options.onShown();
    });

    // Closing hides to the tray; it does not stop collection.
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
      this.hiddenSinceMs = Date.now();
      if (!this.explainedCloseToTray) {
        this.explainedCloseToTray = true;
        this.options.onFirstHide();
      }
      this.options.onHidden();
    });

    window.on('hide', () => {
      this.hiddenSinceMs = Date.now();
    });
    window.on('show', () => {
      this.hiddenSinceMs = null;
    });

    if (this.options.rendererUrl) {
      void window.loadURL(this.options.rendererUrl);
    } else if (this.options.rendererFile) {
      void window.loadFile(this.options.rendererFile);
    }

    this.window = window;
    return window;
  }

  /** Brings the existing window forward, creating it if the app is tray-only. */
  activate(): void {
    const window = this.create();
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  /** Marks a real quit so `close` stops preventing itself. */
  prepareForQuit(): void {
    this.quitting = true;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }
}

/** Resolves the renderer entry for development and production. */
export function resolveRendererEntry(input: {
  readonly isDevelopment: boolean;
  readonly devServerUrl: string | undefined;
  readonly appPath: string;
}): { rendererUrl: string | null; rendererFile: string | null } {
  if (input.isDevelopment && input.devServerUrl) {
    return { rendererUrl: input.devServerUrl, rendererFile: null };
  }
  return {
    rendererUrl: null,
    rendererFile: join(input.appPath, 'out', 'renderer', 'index.html'),
  };
}
