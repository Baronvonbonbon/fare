// Local (foreground) notifications — B4 P1. Fires a browser Notification when a
// relevant order event is seen during the app's existing event polling. No
// server, no keys, no persistent identity — so it never links a per-order burner.
//
// This covers "app open / backgrounded". Waking a fully-CLOSED PWA needs the Web
// Push API (VAPID), which is P2: the venue-node relay as a per-device,
// region-filtered push service watching the chain. See docs/NOTIFICATIONS.md.

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

/// Request permission — MUST be called from a user gesture (a button click).
export async function enableNotifications(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return notifyPermission();
  }
}

/// Fire a local notification when granted. `tag` replaces an existing one with
/// the same tag (per order + kind), so repeated polls don't stack duplicates.
/// Silent no-op when unsupported/not granted.
export function notify(title: string, body: string, tag?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    /* some browsers require the SW registration for notifications — ignore */
  }
}
