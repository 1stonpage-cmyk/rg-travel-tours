import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrpcProviders, trpc } from '@/lib/trpc';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';
import { DESTINATIONS_FIXTURE } from './helpers/fixtures';

function Probe() {
  const { data, isPending } = trpc.destinations.list.useQuery();
  if (isPending) return <p>loading</p>;
  return <p>{data?.map((d) => d.name).join(', ')}</p>;
}

function ErrorProbe() {
  const { error, isPending, isError } = trpc.destinations.list.useQuery();
  if (isPending) return <p>loading</p>;
  if (isError) return <p>errored: {error.message}</p>;
  return <p>no error</p>;
}

describe('tRPC + React Query wiring', () => {
  it('resolves a query through the provider stack', async () => {
    mockTrpc({ 'destinations.list': [{ id: 1, name: 'Oslob', slug: 'oslob' }] });
    render(
      <TrpcProviders>
        <Probe />
      </TrpcProviders>,
    );
    expect(await screen.findByText('Oslob')).toBeInTheDocument();
  });

  it('resolves a query using a fixture shaped like the real API output', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    render(
      <TrpcProviders>
        <Probe />
      </TrpcProviders>,
    );
    expect(await screen.findByText(/Oslob/)).toBeInTheDocument();
  });

  it('surfaces a mocked procedure failure as a query error, not a thrown exception', async () => {
    mockTrpcError('destinations.list');
    render(
      <TrpcProviders>
        <ErrorProbe />
      </TrpcProviders>,
    );
    // retry: 1 means one retry with backoff before the query settles into
    // an error state, so this needs more than the default 1s findBy timeout.
    expect(await screen.findByText(/errored:/, {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
