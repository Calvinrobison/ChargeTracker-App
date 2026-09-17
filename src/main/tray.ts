/**
 * The tray: the app's real presence while the window is closed.
 *
 * Menu: Open, collection status, Pause/Resume, Check for updates, Quit.
 * Quit genuinely stops collection and flushes safely — it is not another hide.
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

import type { CollectionStatusView } from '../shared/ipc.ts';
import type { Logger } from './logger.ts';

export interface TrayControllerOptions {
  readonly iconPath: string | null;
  readonly logger: Logger;
  readonly onOpen: () => void;
  readonly onTogglePause: () => void;
  readonly onCheckForUpdates: () => void;
  readonly onQuit: () => void;
}

/**
 * A 16×16 dark-green charger glyph, used when no icon file is available.
 *
 * Shipping a fallback means a missing asset degrades the icon rather than
 * leaving the user with no tray entry and no way to quit.
 */
function fallbackIcon(): NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <rect width="16" height="16" rx="4" fill="#0D1412"/>
    <path d="M6 3h4v2H6zM5 6h6v5a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" fill="#5DBB97"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
  );
}

export class TrayController {
  private readonly options: TrayControllerOptions;
  private tray: Tray | null = null;
  private status: CollectionStatusView | null = null;
  private updateLabel = 'Check for updates';

  constructor(options: TrayControllerOptions) {
    this.options = options;
  }

  create(): void {
    if (this.tray) return;
    const image = this.options.iconPath
      ? nativeImage.createFromPath(this.options.iconPath)
      : fallbackIcon();
    const icon = image.isEmpty() ? fallbackIcon() : image;

    this.tray = new Tray(icon);
    this.tray.setToolTip('ChargeWatch');
    this.tray.on('double-click', () => this.options.onOpen());
    this.rebuild();
    this.options.logger.log('info', 'tray icon created');
  }

  setStatus(status: CollectionStatusView): void {
    this.status = status;
    this.rebuild();
  }

  setUpdateLabel(label: string): void {
    this.updateLabel = label;
    this.rebuild();
  }

  private statusLabel(): string {
    if (!this.status) return 'Starting…';
    return this.status.label;
  }

  private canPause(): boolean {
    return this.status?.kind !== 'not_started';
  }

  private pauseLabel(): string {
    if (!this.status) return 'Pause collecting';
    return this.status.kind === 'paused' ? 'Resume collecting' : 'Pause collecting';
  }

  private rebuild(): void {
    if (!this.tray) return;

    const menu = Menu.buildFromTemplate([
      { label: 'Open ChargeWatch', click: () => this.options.onOpen() },
      { type: 'separator' },
      // The status line is informational, not clickable.
      { label: this.statusLabel(), enabled: false },
      ...(this.status?.lastObservationMs
        ? [
            {
              label: `Last observation ${new Date(this.status.lastObservationMs).toLocaleTimeString()}`,
              enabled: false,
            } as const,
          ]
        : []),
      { type: 'separator' },
      {
        label: this.pauseLabel(),
        enabled: this.canPause(),
        click: () => this.options.onTogglePause(),
      },
      { label: this.updateLabel, click: () => this.options.onCheckForUpdates() },
      { type: 'separator' },
      { label: 'Quit ChargeWatch', click: () => this.options.onQuit() },
    ]);

    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`ChargeWatch — ${this.statusLabel()}`);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
