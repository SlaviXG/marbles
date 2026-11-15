export type LookObservation = { looking: boolean; at: number };
const LOOK_HOLD_MS = 1200;
const MAX_FRAME_GAP_MS = 1000;

// Startup only: a manual start, pause or failed attempt consumes this gate for
// the page visit. Later face movements can never restart a voice session.
export class LookToWake {
  private consumed = false;
  private since = -1;
  private last = -Infinity;
  get available() { return !this.consumed; }
  resetLook() { this.since = -1; this.last = -Infinity; }
  cancel() { this.consumed = true; this.resetLook(); }
  observe(observation: LookObservation | null, now: number, visible: boolean): boolean {
    if (this.consumed) return false;
    if (!visible || !observation?.looking || now < observation.at || now - observation.at > MAX_FRAME_GAP_MS) {
      this.resetLook(); return false;
    }
    const at = observation.at;
    if (at <= this.last) return false; // Re-reading one frame is not a held look.
    if (at - this.last > MAX_FRAME_GAP_MS || this.since < 0) this.since = at;
    this.last = at;
    if (at - this.since < LOOK_HOLD_MS) return false;
    this.cancel(); return true;
  }
}

// Never prompt for permission from a background startup effect. First-time
// visitors use the orb; returning visitors can use their existing grants.
export async function lookToWakePermitted(): Promise<boolean> {
  try {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || !navigator.permissions?.query) return false;
    const states = await Promise.all(['camera', 'microphone'].map(name =>
      navigator.permissions.query({ name: name as PermissionName })));
    return states.every(state => state.state === 'granted');
  } catch { return false; } // Unsupported permission names: keep tap-to-wake.
}
