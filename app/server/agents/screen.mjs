import Anthropic from '@anthropic-ai/sdk';
import { liveEnv } from '../env.mjs';

// Lets the coordinator look at the interface the user is looking at, cheaply.
//
// Every request already carries a short text description of the screen (what is
// open, what each agent is doing, the last problem). That costs a few hundred
// tokens and answers most questions. Only when it does not, Hermes calls
// look_at_screen: a small, fast vision model reads the latest screenshot and
// answers one specific question in a few sentences. The picture itself never
// enters the coordinator's context, so a long conversation does not carry
// images around.
const MAX_IMAGE_BYTES = 1_200_000;
const visionModel = () => liveEnv('MARBLES_VISION_MODEL') || 'claude-haiku-5-5';

export class Screen {
  constructor({ client, model = visionModel } = {}) { Object.assign(this, { client, model }); this.latest = null; }
  /** Store the newest screenshot (a JPEG or PNG data URL). Kept in memory only. */
  remember(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('Supply a JPEG, PNG or WebP screenshot under 1.2 MB.');
    this.latest = { mediaType: match[1], data: match[2], at: Date.now() };
    return { stored: true };
  }
  async look(question, state) {
    if (typeof question !== 'string' || !question.trim() || question.length > 400) throw new Error('Ask one specific question about the screen.');
    if (!this.latest || Date.now() - this.latest.at > 120_000) return { seen: false, note: 'No recent screenshot is available. Answer from context.screen, and say so if that is not enough.' };
    const apiKey = liveEnv('ANTHROPIC_API_KEY');
    if (!this.client && !apiKey) throw new Error('Add ANTHROPIC_API_KEY to look at the screen.');
    const client = this.client ?? new Anthropic({ apiKey });
    try {
      const response = await client.messages.create({
        model: this.model(), max_tokens: 1200, output_config: { effort: 'low' },
        system: 'You are looking at a screenshot of Marbles, a voice-and-gesture interface where AI agents appear as glowing circles and their files as small sheets. Answer the question about what is visible in at most 70 words of plain text. Report what you actually see, including any error message word for word. If the screenshot does not show what is asked, say that.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: this.latest.mediaType, data: this.latest.data } },
          { type: 'text', text: `What the app reports about itself: ${JSON.stringify(state ?? {}).slice(0, 1500)}\n\nQuestion: ${question.trim()}` },
        ] }],
      });
      if (response.stop_reason === 'refusal') return { seen: false, note: 'The screenshot could not be described. Answer from context.screen.' };
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join(' ').trim();
      return { seen: true, ageSeconds: Math.round((Date.now() - this.latest.at) / 1000), description: text.slice(0, 700) };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic key was rejected, so the screen cannot be read.');
      if (error instanceof Anthropic.RateLimitError) return { seen: false, note: 'Looking at the screen is rate limited right now. Answer from context.screen.' };
      if (error instanceof Anthropic.APIError) return { seen: false, note: `The screenshot could not be read (${error.status ?? 'network'}). Answer from context.screen.` };
      throw error;
    }
  }
}
