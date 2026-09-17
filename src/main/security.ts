/**
 * Desktop security policy (§22), expressed as pure decisions so it can be
 * tested rather than asserted.
 *
 * Renderers run with context isolation on, sandboxing on and Node integration
 * off. They reach the main process only through the narrow preload bridge, and
 * they never load a provider page with application privileges. Provider pages
 * are loaded exclusively by the collector's bundled browser, which has no
 * preload and no Node bridge.
 */

export interface WebPreferencesPolicy {
  readonly contextIsolation: true;
  readonly sandbox: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webviewTag: false;
  readonly enableBlinkFeatures: '';
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly spellcheck: false;
}

/** The only web preferences any ChargeWatch window is created with. */
export const RENDERER_WEB_PREFERENCES: WebPreferencesPolicy = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  enableBlinkFeatures: '',
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
};

/**
 * Content Security Policy.
 *
 * Production allows nothing remote except the configured map tile host, which
 * is required for the interactive basemap. Fonts, styles, scripts and images
 * are bundled, so `'self'` plus `data:` covers them. Development adds only what
 * the Vite dev server needs, and the two are never merged.
 */
export interface CspInputs {
  readonly isDevelopment: boolean;
  /** Tile host origins, e.g. ["https://tile.openstreetmap.org"]. */
  readonly tileOrigins: readonly string[];
  /** The GitHub host used for update checks, when checks are enabled. */
  readonly updateOrigins: readonly string[];
  /** The Vite dev server origin, development only. */
  readonly devServerOrigin?: string;
}

export function buildContentSecurityPolicy(inputs: CspInputs): string {
  const tiles = inputs.tileOrigins.join(' ');
  const dev = inputs.isDevelopment && inputs.devServerOrigin ? inputs.devServerOrigin : '';
  const devWs = dev ? dev.replace(/^http/, 'ws') : '';

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    // No remote scripts, ever. In development Vite needs its own origin and
    // inline module preloads; production gets neither.
    [
      'script-src',
      inputs.isDevelopment ? ["'self'", dev, "'unsafe-inline'"].filter(Boolean) : ["'self'"],
    ],
    // Inline styles are needed because the design system sets many values
    // inline; no remote stylesheet host is permitted in either mode.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['font-src', ["'self'", 'data:']],
    // Map tiles are remote images by necessity.
    ['img-src', ["'self'", 'data:', 'blob:', tiles].filter(Boolean)],
    [
      'connect-src',
      ["'self'", tiles, ...inputs.updateOrigins, dev, devWs].filter(Boolean),
    ],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['worker-src', ["'self'", 'blob:']],
    ['child-src', ["'none'"]],
    ['form-action', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

// ---------------------------------------------------------------------------
// Navigation and window policy
// ---------------------------------------------------------------------------

export type NavigationDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'open_externally'; readonly url: string };

export interface NavigationPolicyInputs {
  /** The renderer's own origin: `file://` in production, the dev server in dev. */
  readonly appOrigins: readonly string[];
  /** Origins the user may be sent to in their system browser. */
  readonly externalOrigins: readonly string[];
}

/**
 * Decides what to do with an attempted navigation.
 *
 * Only the application's own origin may be navigated to in-window. A provider
 * or documentation link is handed to the system browser. Everything else is
 * denied, including `file:`, `data:`, `javascript:` and any unexpected host.
 */
export function decideNavigation(
  rawUrl: string,
  inputs: NavigationPolicyInputs,
): NavigationDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: 'deny', reason: 'not a parseable URL' };
  }

  if (url.protocol === 'javascript:' || url.protocol === 'data:' || url.protocol === 'blob:') {
    return { action: 'deny', reason: `${url.protocol} navigation is never permitted` };
  }

  // The app's own document. `file:` origins serialise as "null", so compare the
  // href prefix for those.
  for (const origin of inputs.appOrigins) {
    if (origin.startsWith('file://')) {
      if (rawUrl.startsWith(origin)) return { action: 'allow' };
      continue;
    }
    if (url.origin === origin) return { action: 'allow' };
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (inputs.externalOrigins.includes(url.origin)) {
      return { action: 'open_externally', url: url.toString() };
    }
    return { action: 'deny', reason: `${url.origin} is not an allowed destination` };
  }

  return { action: 'deny', reason: `${url.protocol} is not an allowed scheme` };
}

/**
 * Permission requests from a renderer.
 *
 * ChargeWatch needs none of them. Everything is denied, which is both correct
 * and the reason no permission prompt ever appears to the user.
 */
export const GRANTED_PERMISSIONS: readonly string[] = [];

export function decidePermission(permission: string): { granted: boolean; reason: string } {
  if (GRANTED_PERMISSIONS.includes(permission)) {
    return { granted: true, reason: 'explicitly allowed' };
  }
  return { granted: false, reason: `ChargeWatch does not use the ${permission} permission` };
}

/**
 * Validates that an IPC message came from a window we created and from the
 * application's own document, not from an embedded frame or a stray page.
 */
export function isTrustedSender(inputs: {
  readonly senderUrl: string;
  readonly appOrigins: readonly string[];
  readonly knownWindowIds: readonly number[];
  readonly senderWindowId: number | null;
  readonly isMainFrame: boolean;
}): { trusted: boolean; reason: string | null } {
  if (!inputs.isMainFrame) {
    return { trusted: false, reason: 'the message came from a subframe' };
  }
  if (inputs.senderWindowId === null || !inputs.knownWindowIds.includes(inputs.senderWindowId)) {
    return { trusted: false, reason: 'the message came from an unrecognised window' };
  }
  const decision = decideNavigation(inputs.senderUrl, {
    appOrigins: inputs.appOrigins,
    externalOrigins: [],
  });
  if (decision.action !== 'allow') {
    return { trusted: false, reason: `the sender document is not the application: ${inputs.senderUrl}` };
  }
  return { trusted: true, reason: null };
}

/** Outbound connections that are a normal part of running ChargeWatch. */
export const DOCUMENTED_OUTBOUND_CONNECTIONS: readonly {
  readonly purpose: string;
  readonly origins: readonly string[];
  readonly optional: boolean;
}[] = [
  {
    purpose: 'Enabled charger status sources, read by the bundled browser',
    origins: ['https://driver.chargepoint.com'],
    optional: false,
  },
  {
    purpose: 'Interactive OpenStreetMap basemap tiles',
    origins: ['https://tile.openstreetmap.org'],
    optional: true,
  },
  {
    purpose: 'GitHub release update checks and downloads',
    origins: ['https://api.github.com', 'https://github.com', 'https://objects.githubusercontent.com'],
    optional: true,
  },
];

/**
 * Strips sensitive values from text destined for a diagnostics bundle.
 *
 * Cookies, authorization headers, tokens and the user's home directory path
 * are removed. This is best-effort redaction on top of a rule that matters
 * more: profiles, credentials and the database are never included at all.
 */
export function redactDiagnosticText(input: string, homeDirectory: string | null): string {
  let out = input;

  // The whole header VALUE goes, not just its first word: "Authorization:
  // Bearer <token>" must not leave the token behind.
  out = out.replace(/(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]');
  out = out.replace(/(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]');
  out = out.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, '$1[redacted]');
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [redacted]');
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '[redacted token]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]');
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[email redacted]');

  if (homeDirectory && homeDirectory.length > 3) {
    const escaped = homeDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '<user home>');
    // Also catch the forward-slash spelling of a Windows home path.
    const forward = homeDirectory.replace(/\\/g, '/');
    if (forward !== homeDirectory) {
      out = out.replace(new RegExp(forward.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user home>');
    }
  }

  return out;
}
