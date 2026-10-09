import { describe, expect, it } from 'vitest';
import { resolveOpenState } from '../services/hours';

const OPEN_7_TO_9 = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  opensAt: '07:00',
  closesAt: '21:00',
  isClosed: false,
}));

describe('open/closed state in Asia/Manila', () => {
  it('is open at 10:00 Manila (02:00 UTC)', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-09T02:00:00.000Z'));
    expect(state.isOpen).toBe(true);
    expect(state.message).toBe('Open now — we reply within minutes');
  });

  it('is closed at 06:00 Manila and names the opening time', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-08T22:00:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });

  it('is closed just after 21:00 Manila and points at tomorrow', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-09T13:01:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });

  it('skips a fully closed day when naming the next opening', () => {
    const closedSunday = OPEN_7_TO_9.map((d) =>
      d.weekday === 0 ? { ...d, isClosed: true, opensAt: null, closesAt: null } : d,
    );
    // Saturday 22:00 Manila = Saturday 14:00 UTC. Next open is Monday 7:00 AM.
    const state = resolveOpenState(closedSunday, new Date('2026-10-10T14:00:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });
});
