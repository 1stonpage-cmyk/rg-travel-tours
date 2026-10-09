import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** Renders the raw query result so a wrong-shaped value (e.g. `{}`) is visible, not just absent. */
function RawProbe() {
  const { data, isPending } = trpc.destinations.list.useQuery();
  if (isPending) return <p>loading</p>;
  return <p>raw: {JSON.stringify(data)}</p>;
}

function NewsletterProbe() {
  const { mutate, data, isPending, isSuccess } = trpc.newsletter.subscribe.useMutation();
  if (!isSuccess && !isPending) {
    return (
      <button type="button" onClick={() => mutate({ email: 'guest@example.com' })}>
        Subscribe
      </button>
    );
  }
  if (isPending) return <p>submitting</p>;
  return <p>subscribed: {JSON.stringify(data)}</p>;
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

  // I1 regression coverage: an async (Promise-returning) handler is the
  // obvious way to write a "deferred resolve" mock (Task 2.4's own test
  // skeleton asks for exactly that). mockTrpc must await it, not serialize
  // the still-pending Promise.
  it('awaits an async handler and delivers its resolved data, not a serialized pending Promise', async () => {
    mockTrpc({
      'destinations.list': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ id: 1, name: 'Oslob', slug: 'oslob' }];
      },
    });
    render(
      <TrpcProviders>
        <RawProbe />
      </TrpcProviders>,
    );
    expect(await screen.findByText(/Oslob/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('routes an async handler rejection to the query error branch, not an empty result', async () => {
    mockTrpc({
      'destinations.list': async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('deferred mock failure');
      },
    });
    render(
      <TrpcProviders>
        <ErrorProbe />
      </TrpcProviders>,
    );
    expect(await screen.findByText(/errored:/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  // I2: the mutation path (inquiries.create / newsletter.subscribe) is
  // method- and body-agnostic in the mock, but was never actually driven
  // through a POST-with-body call before this test.
  it('resolves a mutation through the provider stack', async () => {
    mockTrpc({ 'newsletter.subscribe': { ok: true, alreadySubscribed: false } });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <NewsletterProbe />
      </TrpcProviders>,
    );
    await user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(await screen.findByText(/subscribed:.*"ok":true/)).toBeInTheDocument();
  });
});
