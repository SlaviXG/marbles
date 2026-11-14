import { searchImages, searchYouTube } from '../media/webMedia.mjs';
import { resolveRecipient } from '../comms/comms.mjs';

// Things the coordinator can put in front of the user without starting work:
// open an item on the canvas, show pictures, play a video, or prepare an
// email / call for the user to confirm. Each returns a `display` the app renders.
const text = (maxLength, description) => ({ type: 'string', maxLength, ...(description ? { description } : {}) });
const tool = (name, description, properties) => ({ name, description,
  input_schema: { type: 'object', properties: { ...properties, reply: text(160, 'One short spoken sentence, under 15 words, said as this appears.') },
    required: [...Object.keys(properties), 'reply'], additionalProperties: false } });
export const DISPLAY_TOOLS = [
  tool('open_item', 'Open something on the user’s canvas now: an agent, an agent’s files, a task, a team, a generated file or a note. Use for “open / show / bring up / go to …”. Kind "close" dismisses whatever is open. Does not start work.',
    { kind: { type: 'string', enum: ['agent', 'files', 'task', 'team', 'file', 'note', 'close'] }, ref: text(300, 'Agent ID, task ID, team ID, file name or path, or note ID from context. Empty for close.') }),
  tool('show_images', 'Find pictures on the web and show them in the app. Use for “show me pictures / photos / images of …”.', { query: text(200) }),
  tool('play_video', 'Find a YouTube video and play it inside the app. The query is a topic, a title, or a YouTube link.', { query: text(200) }),
  tool('draft_email', 'Prepare an email. The app shows the draft and sends it only after the user confirms, so never say it was sent.',
    { to: text(254, 'An email address, or a contact’s name.'), subject: text(200), body: text(4000, 'The complete message, ready to send, signed off naturally.') }),
  tool('place_call', 'Prepare a phone call. The app shows who will be called and dials only after the user confirms.', { to: text(254, 'A phone number, or a contact’s name.') }),
];
export const DISPLAY_TOOL_NAMES = DISPLAY_TOOLS.map(item => item.name);

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const has = (a, b) => !!b && String(a ?? '').toLowerCase().includes(String(b).toLowerCase());

export class DisplayTools {
  constructor({ taskService, swarmService, noteProvider = () => [], images = searchImages, videos = searchYouTube, recipient = resolveRecipient } = {}) {
    Object.assign(this, { taskService, swarmService, noteProvider, images, videos, recipient });
  }
  async open({ kind, ref } = {}) {
    if (kind === 'close') return { kind: 'close' };
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 300) throw new Error('Say which item to open.');
    ref = ref.trim();
    const tasks = this.taskService.snapshot();
    const swarms = this.swarmService?.snapshot?.() ?? [];
    if (kind === 'agent' || kind === 'files') {
      const agents = await this.taskService.agentDetector();
      const agent = agents.find(item => same(item.id, ref)) ?? agents.find(item => has(item.name, ref) || has(ref, item.id));
      if (!agent) throw new Error('No agent by that name. Inspect context for agent IDs.');
      return { kind: 'select', id: `${kind === 'agent' ? 'agent' : 'assets'}:${agent.id}` };
    }
    if (kind === 'task' || kind === 'team') {
      const list = kind === 'task' ? tasks : swarms;
      const item = list.find(entry => entry.id === ref) ?? list.find(entry => has(entry.title, ref));
      if (!item) throw new Error(`No ${kind} matches. Inspect context for its ID.`);
      return { kind: 'select', id: `${kind === 'task' ? 'task' : 'swarm'}:${item.id}` };
    }
    if (kind === 'file') {
      const files = [...tasks, ...swarms].flatMap(source => (source.artifacts ?? []).map(file => ({ source, file })));
      const match = files.find(({ file }) => file.path === ref) ?? files.find(({ file }) => same(file.name, ref))
        ?? files.find(({ file }) => has(file.name, ref) || has(file.name.replace(/[-_]+/g, ' '), ref));
      if (!match) throw new Error('No generated file matches. Use find_assets to check names.');
      return { kind: 'select', id: `artifact:${match.source.id}:${encodeURIComponent(match.file.path)}` };
    }
    if (kind === 'note') {
      const notes = await this.noteProvider();
      const note = notes.find(item => item.id === ref) ?? notes.find(item => same(item.title, ref)) ?? notes.find(item => has(item.title, ref));
      if (!note) throw new Error('No note matches. Use search_notes to find it.');
      return { kind: 'select', id: note.id };
    }
    throw new Error('Unknown item kind.');
  }
  async call(name, input) {
    if (!input || typeof input !== 'object') throw new Error('Tool input must be an object.');
    if (name === 'open_item') return this.open(input);
    if (name === 'show_images') return { kind: 'images', query: String(input.query ?? '').trim(), images: await this.images(input.query) };
    if (name === 'play_video') {
      // Whether a video may be embedded is only known for certain when a player
      // tries it, so the app is given the runners-up to fall through to.
      const [video, ...others] = await this.videos(input.query);
      return { kind: 'video', query: String(input.query ?? '').trim(), ...video, alternates: others.slice(0, 5) };
    }
    if (name === 'draft_email') {
      if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 200) throw new Error('Give the email a subject.');
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 4000) throw new Error('Write the email body.');
      const { name: person, address } = await this.recipient(input.to, 'email');
      return { kind: 'email', to: address, name: person, subject: input.subject.trim(), body: input.body.trim() };
    }
    if (name === 'place_call') {
      const { name: person, address } = await this.recipient(input.to, 'call');
      return { kind: 'call', number: address, name: person };
    }
    throw new Error('Unknown display tool.');
  }
}
