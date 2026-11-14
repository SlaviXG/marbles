import { afterEach, expect, it, vi } from 'vitest';
import { ReplySpeaker } from '../voice/ReplySpeaker';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const clips: any[] = [];
  vi.stubGlobal('Audio', class {
    onended?: () => void; onerror?: () => void;
    play = vi.fn(async () => {}); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    constructor() { clips.push(this); }
  });
  const fetchApi = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }) }));
  vi.stubGlobal('fetch', fetchApi);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const active = vi.fn(), error = vi.fn();
  const speaker = new ReplySpeaker({ active, error });
  return { speaker, clips, fetchApi, revoke, active, error };
}

it('speaks a final reply once and releases the audio URL after playback', async () => {
  const { speaker, clips, fetchApi, revoke, active } = setup();
  speaker.enqueue('reply', 'Done.'); speaker.enqueue('reply', 'Done.');
  await vi.waitFor(() => expect(clips).toHaveLength(1));
  expect(fetchApi).toHaveBeenCalledOnce();
  expect(active).toHaveBeenCalledWith(true);
  clips[0].onended();
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:test'));
  expect(active).toHaveBeenLastCalledWith(false);
  speaker.dispose();
});

it('cancels current and queued replies when the user speaks or mutes', async () => {
  const { speaker, clips, fetchApi } = setup();
  speaker.enqueue('a', 'First'); speaker.enqueue('b', 'Second');
  await vi.waitFor(() => expect(clips).toHaveLength(1));
  speaker.setUserSpeaking(true);
  expect(clips[0].pause).toHaveBeenCalled();
  speaker.setEnabled(false); speaker.enqueue('c', 'Muted');
  speaker.setUserSpeaking(false);
  expect(fetchApi).toHaveBeenCalledOnce();
  speaker.dispose();
});

it('keeps written replies usable if autoplay is blocked and allows cached replay', async () => {
  const { speaker, clips, fetchApi, error } = setup();
  vi.stubGlobal('Audio', class {
    play = vi.fn(async () => { throw new Error('NotAllowedError'); });
    pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    constructor() { clips.push(this); }
  });
  speaker.enqueue('one', 'Done');
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('browser blocked')));
  speaker.enqueue('replay', 'Done');
  await vi.waitFor(() => expect(clips).toHaveLength(2));
  expect(fetchApi).toHaveBeenCalledOnce();
  speaker.dispose();
});

it('switches voice immediately and keeps cached speech separate for each voice', async () => {
  const { speaker, clips, fetchApi } = setup();
  speaker.enqueue('reply', 'Done');
  await vi.waitFor(() => expect(clips).toHaveLength(1));
  speaker.enqueue('queued', 'Do not play this');
  speaker.setVoice('cedar');
  expect(clips[0].pause).toHaveBeenCalled();
  speaker.enqueue('reply', 'Done');
  await vi.waitFor(() => expect(clips).toHaveLength(2));
  expect(fetchApi.mock.calls.map(call => JSON.parse((call as any)[1].body))).toEqual([
    { text: 'Done', voice: 'marin' }, { text: 'Done', voice: 'cedar' },
  ]);
  speaker.setVoice('marin');
  speaker.enqueue('replay', 'Done');
  await vi.waitFor(() => expect(clips).toHaveLength(3));
  expect(fetchApi).toHaveBeenCalledTimes(2);
  speaker.dispose();
});

it('ignores an old synthesis response after switching voices', async () => {
  const { speaker, clips, fetchApi } = setup();
  let finishOld!: (value: any) => void;
  fetchApi.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  speaker.enqueue('reply', 'Done');
  const oldSignal = (fetchApi.mock.calls[0] as any)[1].signal;
  speaker.setVoice('cedar');
  expect(oldSignal.aborted).toBe(true);
  speaker.enqueue('reply', 'Done');
  await vi.waitFor(() => expect(clips).toHaveLength(1));
  finishOld({ ok: true, blob: async () => new Blob(['old'], { type: 'audio/mpeg' }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(clips).toHaveLength(1);
  expect(clips[0].pause).not.toHaveBeenCalled();
  speaker.dispose();
});
