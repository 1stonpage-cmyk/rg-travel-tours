import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flattenZodError } from '../zod-errors';

describe('flattenZodError', () => {
  it('flattens a nested-object issue to both the group key and the dot-path key', () => {
    const schema = z.object({ lead: z.object({ phone: z.string().min(5, 'too short') }) });
    const result = schema.safeParse({ lead: { phone: 'x' } });
    if (result.success) throw new Error('expected failure');
    const flat = flattenZodError(result.error);
    expect(flat.fieldErrors.lead).toEqual(['too short']);
    expect(flat.nestedFieldErrors['lead.phone']).toEqual(['too short']);
  });

  it('leaves a top-level issue out of nestedFieldErrors', () => {
    const schema = z.object({ name: z.string().min(2, 'short') });
    const result = schema.safeParse({ name: 'a' });
    if (result.success) throw new Error('expected failure');
    const flat = flattenZodError(result.error);
    expect(flat.fieldErrors.name).toEqual(['short']);
    expect(Object.keys(flat.nestedFieldErrors)).toHaveLength(0);
  });
});
