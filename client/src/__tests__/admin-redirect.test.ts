import { describe, expect, it } from 'vitest';
import { sanitizeAdminRedirect } from '@/lib/admin-redirect';

describe('sanitizeAdminRedirect', () => {
  it('accepts a same-origin admin path', () => {
    expect(sanitizeAdminRedirect('/admin/bookings/42')).toBe('/admin/bookings/42');
  });

  it('accepts an admin path with a query string', () => {
    expect(sanitizeAdminRedirect('/admin/bookings?status=pending')).toBe(
      '/admin/bookings?status=pending',
    );
  });

  it('refuses a protocol-relative URL (open-redirect attempt)', () => {
    expect(sanitizeAdminRedirect('//evil.example.com/admin')).toBeNull();
  });

  it('refuses an absolute external URL', () => {
    expect(sanitizeAdminRedirect('https://evil.example.com/admin')).toBeNull();
  });

  it('refuses a path outside /admin', () => {
    expect(sanitizeAdminRedirect('/checkout')).toBeNull();
  });

  it('refuses a path-traversal attempt that would walk outside /admin', () => {
    expect(sanitizeAdminRedirect('/admin/../checkout')).toBeNull();
  });

  it('refuses null and empty input', () => {
    expect(sanitizeAdminRedirect(null)).toBeNull();
    expect(sanitizeAdminRedirect('')).toBeNull();
  });
});
