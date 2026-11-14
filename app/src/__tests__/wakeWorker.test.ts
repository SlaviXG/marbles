import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ model: vi.fn(), pipeline: vi.fn() }));
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } }, pipeline: fake.pipeline,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); fake.model.mockReset(); fake.pipeline.mockReset(); });

it('reports ready only after a one-second silence warm-up resolves', async () => {
  let finish!: (value: { text: string }) => void;
  fake.model.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fake.pipeline.mockResolvedValue(fake.model);
  const messages: any[] = [];
  const worker = { location: { href: 'http://localhost/' }, navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: false,
    postMessage: (message: unknown) => messages.push(message), onmessage: null as any };
  vi.stubGlobal('self', worker);
  await import('../voice/wake.worker');
  const loading = worker.onmessage({ data: { type: 'load' } });
  await vi.waitFor(() => expect(fake.model).toHaveBeenCalledOnce());
  expect(fake.model.mock.calls[0][0]).toHaveLength(16_000);
  expect(messages.some(message => message.type === 'ready')).toBe(false);
  finish({ text: '' });
  await loading;
  expect(messages[messages.length - 1].type).toBe('ready');
});
