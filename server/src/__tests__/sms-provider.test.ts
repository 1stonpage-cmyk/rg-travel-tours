/**
 * Week 7, Task 14 (7E): the SMS interface, **built switched off** (owner
 * decision 2026-10-23, Q6 — "SMS is not paid for; email only this week").
 *
 * So the whole point of this file is what the seam does when nothing is
 * configured and when something is configured WRONG:
 *
 *  - unset `SMS_PROVIDER` selects the null provider, which logs and sends
 *    nothing, and cannot throw — exactly how `notify()` behaves with no SMTP
 *    host;
 *  - an unknown name is REFUSED, not defaulted. `services/payments/registry.ts`
 *    is the pattern: "a typo in a webhook URL must not route money through
 *    whichever gateway happens to be first in the table." The SMS equivalent
 *    is a typo silently routing a guest's phone number through a provider
 *    nobody chose.
 *
 * No test here sends an SMS, because nothing in this codebase can: there is no
 * registered provider to send one with, and that absence is asserted below
 * rather than assumed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SMS_PROVIDER_NAMES,
  UnknownSmsProviderError,
  nullSmsProvider,
  selectSmsProvider,
} from '../services/notify/sms';

describe('the SMS provider registry', () => {
  it('selects the null provider when SMS_PROVIDER is unset', () => {
    for (const unset of [undefined, '', '   ']) {
      expect(selectSmsProvider(unset), JSON.stringify(unset)).toBe(nullSmsProvider);
    }
  });

  /**
   * The fail-closed half. A name nobody registered has exactly one answer, and
   * it is not "the first provider in the table".
   */
  it('REFUSES an unknown provider name rather than defaulting', () => {
    expect(() => selectSmsProvider('semaphore')).toThrow(UnknownSmsProviderError);
    expect(() => selectSmsProvider('twilio')).toThrow(UnknownSmsProviderError);
    // A `Map`, not an object literal — so the inherited keys of
    // `Object.prototype` are not providers either (the hazard
    // `services/payments/registry.ts` documents).
    expect(() => selectSmsProvider('__proto__')).toThrow(UnknownSmsProviderError);
    expect(() => selectSmsProvider('constructor')).toThrow(UnknownSmsProviderError);
  });

  /** The refusal names what was asked for, so a misconfigured deploy is obvious. */
  it('names the rejected provider in the error', () => {
    expect(() => selectSmsProvider('semaphore')).toThrow(/semaphore/);
  });

  /**
   * Q6, asserted rather than assumed: **nothing is registered this week.** If
   * a provider is ever added, this test goes red and whoever added it has to
   * come back and decide what the rest of this file should say about it.
   */
  it('registers no real provider at all — SMS is off this week', () => {
    expect(SMS_PROVIDER_NAMES).toEqual([]);
  });

  it('sends nothing, and never throws, through the null provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      nullSmsProvider.send({ to: '+639170000000', text: 'Your tour is tomorrow.' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  /**
   * The log line may say that an SMS was not sent. It may NOT quote the phone
   * number or the message: a log is read by anyone with server access and is
   * often shipped to a third-party aggregator, and a guest's mobile number is
   * personal data under RA 10173. The same rule `notify()`'s failure log
   * follows.
   */
  it('puts no phone number and no message body in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await nullSmsProvider.send({ to: '+639170000000', text: 'Pickup at 4am, Radisson lobby' });

    const line = warn.mock.calls.flat().map(String).join(' ');
    expect(line, 'a phone number reached the log').not.toContain('639170000000');
    expect(line, 'a message body reached the log').not.toContain('Radisson');
    vi.restoreAllMocks();
  });
});
