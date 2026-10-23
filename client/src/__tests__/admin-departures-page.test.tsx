/**
 * The departures board on its own screen. The board's rows are pinned in
 * `departures-board.test.tsx`; this pins only that the page mounts it with a
 * heading of its own, and that the board does not link to itself.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminDeparturesPage from '@/pages/admin/AdminDeparturesPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

afterEach(resetTrpcMock);

describe('AdminDeparturesPage', () => {
  it('shows the departures board under a page heading, with no link to itself', async () => {
    mockTrpc({ 'admin.departures.today': [] });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminDeparturesPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Departures board' })).toBeTruthy();
    expect(await screen.findByTestId('departures-board')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Departures board' })).toBeNull();
  });
});
