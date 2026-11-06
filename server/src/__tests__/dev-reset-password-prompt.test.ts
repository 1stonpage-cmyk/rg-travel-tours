/**
 * Task 1A review, I3 — the echo suppression in
 * `scripts/dev-reset-staff-password.ts`.
 *
 * This is the one piece of novel, security-critical logic in that file, and it
 * leans on `_writeToOutput`, a PRIVATE readline API. The I2 finding (readline
 * writes its line-refresh escapes straight to `output`, bypassing that hook)
 * is proof the hook is not a stable contract — and if a future Node moves the
 * line text off it too, muting fails **OPEN**: the password echoes and nothing
 * else in the suite would go red. CLAUDE.md requires a security control to
 * fail closed with a test for the failure path, so the bytes are asserted
 * here rather than trusted.
 *
 * No process, no terminal, no database: a `PassThrough` with `isTTY` set and a
 * `setRawMode` stub is enough for readline to run its full terminal path.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { openPrompt } from '../../scripts/dev-reset-staff-password';

/** Not a credential: a fixed literal that only ever exists in this file. */
const TYPED = 'correct-horse-battery';
const LABEL = 'New password (not shown): ';

interface FakeTty extends PassThrough {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

function fakeTerminal() {
  const input = new PassThrough() as FakeTty;
  input.isTTY = true;
  // readline calls this when it owns a terminal; a PassThrough has no such
  // method, and without the stub readline would silently skip raw mode — the
  // same gap that let I2 through the original fake-TTY harness.
  input.setRawMode = () => {};

  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk: Buffer) => {
    captured += chunk.toString();
  });

  return { input, output, captured: () => captured };
}

describe('dev:reset-password hidden prompt', () => {
  it('returns what was typed but never writes it to the output', async () => {
    const { input, output, captured } = fakeTerminal();
    const prompt = openPrompt(input, output);

    const answer = prompt.askHidden(LABEL);
    input.write(`${TYPED}\n`);
    expect(await answer).toBe(TYPED);
    prompt.close();

    // The whole point. Not a substring of it either: a partial echo of a
    // password is still an echo, so check a few leading characters as well.
    expect(captured()).not.toContain(TYPED);
    expect(captured()).not.toContain(TYPED.slice(0, 8));
  });

  it('keeps the label on screen — the muted writer re-emits it (I2)', async () => {
    const { input, output, captured } = fakeTerminal();
    const prompt = openPrompt(input, output);

    const answer = prompt.askHidden(LABEL);
    input.write(`${TYPED}\n`);
    await answer;
    prompt.close();

    // readline's refresh escapes erase the line before the hook is called, so
    // a writer that emitted NOTHING left the developer typing a password into
    // a blank line. The label has to survive that erase.
    expect(captured()).toContain(LABEL);
    expect(captured().lastIndexOf(LABEL)).toBeGreaterThan(captured().indexOf('[0J'));
  });

  it('draws the label ONCE, not once per keystroke', async () => {
    const { input, output, captured } = fakeTerminal();
    const prompt = openPrompt(input, output);

    const answer = prompt.askHidden(LABEL);
    input.write(`${TYPED}\n`);
    await answer;
    prompt.close();

    /*
     * Measured in a real console: readline's `_insertString()` fast path
     * hands the hook the single typed CHARACTER, with no erase before it, so
     * a writer that answered every chunk with the label reprinted the label
     * once per keystroke across the terminal. One draw per full-line refresh
     * is the whole budget; `TYPED.length` draws is the bug.
     */
    const drawn = captured().split(LABEL).length - 1;
    expect(drawn).toBeGreaterThanOrEqual(1);
    expect(drawn).toBeLessThan(4);
    expect(drawn).toBeLessThan(TYPED.length);
  });

  it('the VISIBLE prompt still echoes — the mute is scoped to askHidden', async () => {
    const { input, output, captured } = fakeTerminal();
    const prompt = openPrompt(input, output);

    const answer = prompt.ask('Staff email: ');
    input.write('someone@example.invalid\n');
    expect(await answer).toBe('someone@example.invalid');
    prompt.close();

    // Proves the mute is a state, not the permanent behaviour of the hook —
    // and that a muting bug cannot hide behind "nothing echoes anywhere".
    expect(captured()).toContain('someone@example.invalid');
  });

  it('unmutes after a hidden prompt, so a later visible one is not masked', async () => {
    const { input, output, captured } = fakeTerminal();
    const prompt = openPrompt(input, output);

    const hidden = prompt.askHidden(LABEL);
    input.write(`${TYPED}\n`);
    await hidden;

    const visible = prompt.ask('Staff email: ');
    input.write('later@example.invalid\n');
    await visible;
    prompt.close();

    expect(captured()).toContain('later@example.invalid');
    expect(captured()).not.toContain(TYPED);
  });
});
