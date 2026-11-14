import { execFile } from 'node:child_process';

// Email and calls go through the user's own Mac apps (Mail, Contacts,
// FaceTime / iPhone calling), so there are no accounts or keys to configure.
// Nothing here runs until the user has confirmed a draft in the app. Every
// value is passed as a separate argument, never spliced into a script.
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isEmail = value => typeof value === 'string' && value.length <= 254 && EMAIL.test(value.trim());
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[\s().-]/g, '');
  return /^\+?\d{3,15}$/.test(digits) ? digits : null;
}

function osascript(args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

const CONTACTS = `function run(argv) {
  const people = Application('Contacts').people.whose({ name: { _contains: argv[0] } })();
  return JSON.stringify(people.slice(0, 5).map(p => ({ name: p.name(), emails: p.emails().map(e => e.value()), phones: p.phones().map(e => e.value()) })));
}`;
const MAIL = `on run argv
  tell application "Mail"
    set draft to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:false}
    tell draft to make new to recipient at end of to recipients with properties {address:(item 1 of argv)}
    send draft
  end tell
end run`;

/** People in the user's Contacts whose name contains the spoken name. */
export async function findContacts(name, { run = osascript, platform = process.platform } = {}) {
  if (platform !== 'darwin' || typeof name !== 'string' || !name.trim() || name.length > 120) return [];
  try {
    const found = JSON.parse(await run(['-l', 'JavaScript', '-e', CONTACTS, name.trim()]));
    return Array.isArray(found) ? found.map(person => ({ name: String(person.name ?? ''), emails: (person.emails ?? []).filter(isEmail),
      phones: (person.phones ?? []).map(normalizePhone).filter(Boolean) })) : [];
  } catch { return []; }
}

/** Turn "Sam" or "sam@example.com" into a name and address, or explain what is missing. */
export async function resolveRecipient(to, kind, options) {
  if (typeof to !== 'string' || !to.trim() || to.length > 254) throw new Error('Say who this is for.');
  const value = to.trim();
  if (kind === 'email' && isEmail(value)) return { name: '', address: value };
  if (kind === 'call' && normalizePhone(value)) return { name: '', address: normalizePhone(value) };
  const people = (await findContacts(value, options)).filter(person => (kind === 'email' ? person.emails : person.phones).length);
  if (!people.length) throw new Error(`No ${kind === 'email' ? 'email address' : 'phone number'} found for ${value} in Contacts. Ask the user for it.`);
  if (people.length > 1 && new Set(people.map(person => person.name)).size > 1) throw new Error(`Several contacts match ${value}: ${people.map(person => person.name).join(', ')}. Ask which one.`);
  return { name: people[0].name, address: (kind === 'email' ? people[0].emails : people[0].phones)[0] };
}

/** Send through Mail.app. Elsewhere, hand back a mailto link for the browser to open. */
export async function sendEmail({ to, subject, body } = {}, { run = osascript, platform = process.platform } = {}) {
  if (!isEmail(to)) throw new Error('A valid email address is required.');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new Error('A subject under 200 characters is required.');
  if (typeof body !== 'string' || !body.trim() || body.length > 8000) throw new Error('A message under 8,000 characters is required.');
  const link = `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (platform !== 'darwin') return { sent: false, link };
  try { await run(['-e', MAIL, to.trim(), subject.trim(), body], { timeoutMs: 30_000 }); return { sent: true }; }
  catch { return { sent: false, link }; }
}

/** Start a call through the Mac's phone handler (FaceTime / iPhone), which asks the user before dialling. */
export function placeCall({ number } = {}, { open = (target) => execFile('open', [target], () => {}), platform = process.platform } = {}) {
  const digits = normalizePhone(number);
  if (!digits) throw new Error('A valid phone number is required.');
  const link = `tel:${digits}`;
  if (platform !== 'darwin') return { started: false, link };
  open(link);
  return { started: true };
}
