import { afterEach, expect, it, vi } from 'vitest';
import { useDisplay } from '../state/display';

afterEach(() => { useDisplay.getState().close(); vi.unstubAllGlobals(); });
it('only sends on confirmation and reports a Nylas receipt accurately', async () => {
  const fetch = vi.fn(async (_url: string, _request: { body: string }) => ({ ok: true, json: async () => ({ sent: true, via: 'Nylas', messageId: 'id' }) }));
  vi.stubGlobal('fetch', fetch);
  useDisplay.getState().show({ kind: 'email', draftId: 'approved-draft', to: 'sam@example.com', name: '', subject: 'Hi', body: 'Hello' });
  expect(fetch).not.toHaveBeenCalled();
  await useDisplay.getState().confirm();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ draftId: 'approved-draft' });
  expect(useDisplay.getState()).toMatchObject({ status: 'done', note: 'Email sent' });
  await useDisplay.getState().confirm();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps the same draft after an uncertain send and does not offer another mail provider', async () => {
  const fetch = vi.fn(async (_url: string, _request: { body: string }) => { throw new Error('Delivery not confirmed'); });
  vi.stubGlobal('fetch', fetch);
  useDisplay.getState().show({ kind: 'email', draftId: 'same-draft', to: 'sam@example.com', name: '', subject: 'Hi', body: 'Hello' });
  await useDisplay.getState().confirm();
  expect(useDisplay.getState()).toMatchObject({ status: 'failed', mailFallback: false });
  await useDisplay.getState().confirm();
  expect(fetch.mock.calls.map(([, request]) => JSON.parse(request.body).draftId)).toEqual(['same-draft', 'same-draft']);
});
