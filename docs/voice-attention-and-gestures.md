# Voice, attention and gestures

How Marbles decides when to listen, what to ignore, what it remembers, and what
your hands can do. Everything here runs in the browser unless it says otherwise.

## When the microphone is open

Once the controls are enabled, Marbles is in one of three states.

| State | What it means | How you get there |
| --- | --- | --- |
| Waiting | Listening for “Marbles”; no audio goes to command transcription. Browser-assisted wake recognition may use the browser’s speech service. | The default once the orb is on. |
| Armed | Ready for a request. Speech is sent to the transcriber when you start talking. | Say "Marbles". |
| Listening | You are speaking; your words are being transcribed. | Start talking while armed. |

It returns to Waiting as soon as a request is submitted, without waiting for
Hermes to answer. Follow-up requests, including answers to clarification
questions, need “Marbles” again. Saying only “Marbles” leaves a short window to
describe the task. That window expires after 20 seconds without speech; looking
at the screen cannot extend it. Looking away may shorten an already quiet turn
to three seconds. Pausing the orb turns off microphone and camera entirely.

### Looking at the screen (head pose)

A small camera stream watches for faces, either at startup with existing
permissions or while the controls are enabled.

At startup, when camera and microphone permissions are already granted, the
orb shows **Look here to wake**. The camera is on but the microphone stays off
until a continuous look of at least 1.2 seconds enables voice and hand control.
This only replaces the initial orb tap: it enters Waiting, not Armed. A glance,
missing face, hidden page or stalled camera resets the hold. The startup hold
uses raw head-pose observations rather than the indicator's smoothing below.

Startup activation is available once per page visit. A manual start, pause,
cancel or failed automatic attempt consumes it. **Cancel look to wake** turns
off the startup camera and leaves the orb available. A hidden page stops that
camera until it is visible again. First-time permissions and browsers without
permission-query support fall back to tapping. If audio cannot start without a
browser interaction, the automatic attempt releases microphone and camera and
asks for a tap. Automatic activation does not request screen sharing.

1. MediaPipe's face landmarker runs in a worker, about four times a second, on a
   192-pixel-wide frame (less often while a hand is active).
2. The **nearest person** is chosen: the largest face in view.
3. That face's transformation matrix gives the direction the head points. Yaw
   and pitch are read from it (`src/attention/headPose.ts`).
4. You count as looking when the head is within 24° sideways and 22° up or down
   of straight at the camera. Once you are looking, the cone widens by a quarter
   so a nod or a glance at the keyboard does not drop you.
5. Timing smooths the indicator: 0.3 s of looking to engage, 1.8 s of looking
   away to release, 2.6 s with no face before "nobody is there".

The gesture panel shows **Eyes on** or **Looking away** while a face is tracked.
These are camera indicators, not permission to transcribe. Head pose cannot arm
listening, extend its deadline, or keep it armed after a submitted request.

What it is and is not:

- It is head pose, not eye tracking. Turning your eyes while your head stays
  square to the screen still counts as looking.
- Frames never leave the device and are not stored.
- If the camera or the model is unavailable, nothing breaks: the wake word works
  as before.
- Turn it off with `?attention=off` in the address (remembered), or back on with
  `?attention=on`.

Tunable numbers live in `ATTENTION` in `src/attention/headPose.ts`.

### Ignoring the laptop's own sound and the room

Four things work together. None is perfect alone.

1. **Echo cancellation and voice isolation.** The microphone is opened with echo
   cancellation, noise suppression and, where the system supports it, voice
   isolation. Echo cancellation removes what this browser is itself playing,
   which covers a video playing in the app and Marbles' spoken replies.
2. **Ducking.** While Marbles is armed, listening or speaking, a video playing in
   the app drops to 12% volume and comes back afterwards (`src/voice/ducking.ts`).
3. **Background detection.** Speech breathes: every few seconds it falls back
   toward the room level between words. Music and soundtracks do not. Sound that
   runs 3.5 s without its quietest 20 ms dropping below 30% of its average is
   judged background. The turn is closed, its transcript is thrown away, the
   half-written subtitle is removed, and that level becomes the new room level so
   it stops opening turns. Speaking over it still works, because a voice is
   louder than its bed (`AudioTurns` in `src/voice/audio.ts`).
4. **Wake-word gating.** Facing the camera cannot open command transcription.
   An explicit wake word opens a turn, and submission returns it to standby.

Known limits:

- Sound from **other apps** (a music player outside the browser) is not covered
  by echo cancellation on every system. Wake-word gating and background
  detection reduce unintended transcription.
- A song with long pauses, or speech-like audio such as a podcast, can still be
  transcribed during an explicitly awakened turn. A false wake-word detection
  can also open a turn. Pause the orb when no microphone capture is wanted.
- Someone talking without a single pause for 3.5 s in a very noisy room could be
  misread as background. Raise `BACKGROUND_SECONDS` if that happens.

## How requests are processed

### Newest first, nothing dropped

Only one request is with Hermes at a time. Anything you say meanwhile is held on
the device. When Hermes answers, everything held goes out together: the newest
as the request, the rest as `earlier`, oldest first.

Hermes is told to act on the newest request first and to let it override
anything it contradicts, then to deal with each earlier one: delegate it, answer
it, or drop it only because the newest cancelled it. If the newest request was
answered or shown rather than delegated, the server gives the earlier ones a
turn of their own straight away, and you hear both replies.

### Memory

The last eight turns are kept word for word. Older turns are not discarded:
they are folded, in the background, into a running summary of under 120 words
(goals, decisions, names, files, unfinished requests). Hermes receives it as
`memory` with every request. If the summary call fails, a plain trimmed
transcript is kept instead.

Memory lasts for the conversation, not across restarts of the server.

### The model

Hermes runs on `claude-opus-5-5` with adaptive thinking at `medium` effort. It
is noticeably better than the previous Sonnet default at counting tasks in a
sentence, resolving "it" and "that", and choosing the right tool, for a few
seconds more per request (roughly 9–15 s in testing).

| Setting (`.env`) | Default | Notes |
| --- | --- | --- |
| `MARBLES_COORDINATOR_MODEL` | `claude-opus-5-5` | `claude-sonnet-5-5` is faster and cheaper. |
| `MARBLES_COORDINATOR_EFFORT` | `medium` | `low` is quicker; `high` thinks longer. |

## Gestures

| Gesture | What it does |
| --- | --- |
| Point | Moves the cursor. |
| Pinch and release | Opens what you are pointing at. |
| Pinch, hold and move | Drags it: any window by its title bar, any teammate or file on the canvas. A teammate's files travel with it. |
| Pinch with both hands | Zoom (hands apart or together) and pan (hands moving together). |
| **Open palm, aim, swish** | Rest the open palm over the window until its outline lights, then sweep sideways. Closes only that window, including YouTube. |
| **Pinch a window and fling it** | Closes it. Grab the title bar, throw, and let go while it is still moving: it flies off and closes. Set down gently, it just stays where you put it. |
| **Pinch a slide** | Next slide. The left edge of the slide goes back. |
| **Drop your hands** | Closes whatever is on the main stage. The hand must fall out of the bottom of the view at speed and stay gone. A video keeps playing. |

Swishes require at least three extended fingers, a 220 ms steady aim at a
window, then a fast, straight sweep over at least 160 px (scaled for screen
width). Pointing with one finger, normal reaching, pinches and two-hand zooms
cannot trigger them. A faint outline marks the armed window; one swish closes
one window, followed by a cooldown. `SWISH` in `src/input/dismissGesture.ts`
holds the thresholds. Short tracking gaps are tolerated without inventing motion.

Pinch-and-fling remains an alternative. A throw is measured at release: at least
1500 px/s, averaged over the last 140 ms (the pinch opening jolts the final
frames), after a drag of at least 140 px. Thresholds are `FLING` in
`src/hooks/useDragMove.ts`.

Dropping your hands is deliberately hard to do by accident: in view for about a
second first, then leaving downward at over 1300 px/s, steeply, from the lower
third, and not coming straight back. Lowering your hands to rest does nothing.
Thresholds are `DISMISS` in `src/input/dismissGesture.ts`.

While a document is open the cursor is steadied a little against hand tremor,
and not at all during a drag, so what you carry follows your hand exactly.
Synthetic pointer capture keeps the grabbed object attached across other
windows and screen edges. A lost hand cancels the grab rather than clicking or
throwing it. Windows engage after at most 16 px of movement, canvas items 18 px.

## Worker file access and window commands

`MARBLES_AGENT_ACCESS=full` in the private repo-root `.env` enables local
account-wide file access for Codex and Claude workers, including swarms. Codex
uses `danger-full-access` with non-interactive approvals; Claude skips its
headless permission prompts. The default remains `workspace` for other installs.
macOS account and privacy permissions still apply. Explicit destination paths
are respected, with preview copies of generated deliverables kept in the task
workspace. This setting does not expose arbitrary files through the HTTP API.

Hermes has `close_window` with targets `video`, `media`, `selection`, and `all`.
“Close YouTube”, “close the video window”, and “close all windows” also work
locally without a model round trip. Generic close receipts now include the
separate video player.

## Finishing speech

Speech is judged in 20 ms blocks and ends after roughly 500 ms of quiet.
Brief noise spikes do not restart that timer; a steady lower-volume music/fan
tail is treated as background while quieter, varying final words stay in the
turn. The transcript is submitted as soon as its final text arrives.
Spoken replies keep the name “Marbles”. Both recognizers are suspended during
playback and briefly afterward, so the name cannot make Marbles answer itself.

The face model that watches where you are looking shares the processor with the
hand tracker. While a hand is in view it checks about once a second instead of
four times, so pointing and dragging get the cores.

## Spoken replies and keys

Replies use ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise OpenAI.

- Keys live in the repo-root `.env`. **Linked git worktrees share the main
  checkout's `.env`**, so one file serves every worktree.
- Keys are re-read when `.env` changes. Adding or fixing a key takes effect on
  the next reply without restarting anything.
- On start the dev server prints which `.env` it found and which provider is
  active, for example `[marbles] spoken replies: elevenlabs`.
- If ElevenLabs rejects a request, the server log says why (`http_401`: the key
  was rejected; `http_402`: the voice needs a paid plan) and that reply falls
  back to OpenAI.
- Only one copy of the app should be running. Two dev servers on port 5173 (one
  on IPv4, one on IPv6) means `localhost` can reach an older copy.

## What Marbles knows about its own screen

Marbles can be asked about what you are looking at ("what is this", "why did
the video stop", "close that"), and it should understand a problem before
explaining it. It gets that in two tiers, so it does not pay for pictures it
does not need.

1. **A description, with every request.** A couple of hundred characters of
   plain facts: what is open, what each agent is doing and its latest line, how
   many tasks are queued, the state of voice, hands and eyes, and the most
   recent problem the interface hit (a video that would not embed, an email
   that was not sent, a failed request). Built by `describeScreen()` in
   `src/state/screen.ts`.
2. **A picture, only when Hermes asks.** Just before each request the app leaves
   a small JPEG with the local server (about 20 KB, memory only). If the
   description does not settle the question, Hermes calls `look_at_screen` with
   one specific question. A small vision model (`claude-haiku-5-5` by default)
   reads the picture and answers in a sentence or two. The image never enters
   Hermes's own context, so a long conversation does not carry pictures around.

By default the picture is a **sketch**: the scene canvas with each open window
drawn as a labelled outline containing its text. It needs no permission. For a
true screenshot open the app once with `?see=tab` (remembered): the browser asks
to share the tab when you tap the orb. `?see=off` sends no picture at all.

| Setting (`.env`) | Default | Notes |
| --- | --- | --- |
| `MARBLES_VISION_MODEL` | `claude-haiku-5-5` | The model that reads screenshots. |

## Videos that will not embed

Some YouTube videos do not allow playing inside another site, and that is only
known for certain when a player tries. So a video request returns the best match
plus five runners-up. If the player reports a refusal (the video's owner has
embedding off, or it was removed or restricted), the window moves to the next
one on its own. If none will play, the window says so and Marbles is told, so it
can explain instead of leaving a dead player.

## Email

With Nylas configured, Hermes prepares a local email preview showing the recipient,
subject, body and attachment filenames/sizes. Saying “send it” or pinching Send
confirms exactly that preview. Only the server calls Nylas; Codex and Claude do
not need Gmail connectors. No email is sent while a draft is being prepared.

- Existing files: Hermes uses `find_assets`, then `draft_email` with the chosen
  workspace asset paths. Unlisted files and paths outside the workspace are rejected.
- “Make a deck and email it to me”: Hermes delegates creation with an `email`
  intent. The worker creates files only. When finished, Hermes chooses its final
  deliverables and shows an email preview for confirmation.
- Attachments total at most 20 MB. Their contents are checked again on confirmation;
  if a file changed or disappeared, a fresh preview is required.
- Repeat confirmation and retries reuse the same Nylas idempotency key. A timeout
  is shown as unconfirmed delivery, with no automatic fallback to another sender.
  After 55 minutes an uncertain send must be checked in Sent mail before preparing
  another preview. Previews and send receipts are local to the running server;
  after a restart, expired previews cannot send.

Configure server-only `NYLAS_API_KEY`, `NYLAS_GRANT_ID`, and `NYLAS_API_URI`
(`https://api.eu.nylas.com` or `https://api.us.nylas.com`) in the ignored `.env`.
Use a grant-bound Nylas IAM key with `messages.send` permission. `MARBLES_USER_EMAIL`
sets the address used for “me”. Never put the key in a `VITE_` variable or a worker
prompt. New worker processes do not inherit the Nylas key.

Nylas is selected automatically when its configuration is present, or explicitly
with `MARBLES_EMAIL_VIA=nylas`. Legacy text-only routes remain available through
`MARBLES_EMAIL_VIA=agent` or `mail`; attachment previews require Nylas. Ordinary
workers receive legacy Gmail tool permission only with `MARBLES_AGENT_GMAIL=on`.

References: [Nylas sending](https://developer.nylas.com/docs/v3/email/send-email/),
[idempotency](https://developer.nylas.com/docs/v3/email/idempotent-send/),
[multipart attachments](https://support.nylas.com/hc/en-us/articles/19492515408669-Sending-attachments-in-API-V3-larger-than-3MB-via-multipart).

## Slide decks

Decks open one slide at a time: pinch the slide for the next one, the left edge
for the previous one, or say "next slide", "go back", "first slide", "last
slide". Arrow keys work too.

That covers PowerPoint files and **HTML decks**. Agents often build a deck as an
HTML page whose "next" button is JavaScript. Marbles never runs scripts in files
an agent produced, so that button was dead and only the first slide showed. The
viewer now finds the slides in the page itself (`section.slide`, `.slides >
section`, reveal.js and similar layouts), shows exactly one filling a 16:9 frame,
and pages them with its own controls. An HTML page that is not a deck is shown
whole, as before.

## Responsiveness

- A turn ends 0.6 s after you stop. Quiet is judged against how loudly you were
  speaking, not only against the room, so noise after your sentence no longer
  keeps the microphone open until the 15 s cap.
- The moment you stop, "thinking" dots appear, before the transcript is back.
- The screenshot left for Hermes is no longer waited for before the request goes.
- Hermes itself takes 3–10 s depending on the request. `low` effort measured no
  faster than `medium`, so the default stays `medium`.

## Sling-ring portal Easter egg

With gestures active, keep your thumb away from your index finger and trace
**one large, relaxed circle**, about 1–4 seconds. Clockwise and counterclockwise
both work, and an oval is fine. A guiding spark trail and “Keep circling” cue
appear as the loop nears completion. Completing most of the circle opens a fiery
portal, reveals Andrew Garfield’s Spider-Man, then collapses into falling embers.

The gesture widget’s **Portal trick** disclosure has instructions and a
**Preview portal** button for mouse and keyboard, without a camera. The preview
includes the drawn circle, opening, reveal, collapse and ember sequence, lasting
8.5 seconds. The canvas remains interactive and Escape dismisses the effect.
Reduced motion shows a stationary ring with a quiet fade, without flying sparks,
rotation, scaling or a moving fingertip trail.

Recognition uses raw camera coordinates before cursor gain and magnetism. A loop
must span at least 18% of the camera frame on both axes, wind consistently through
at least 315 degrees, and finish near its starting point. It accepts moderate
ellipses and noise, ignores lead-in reaches, and tolerates a tracking gap of up to
300 ms without inventing movement. Longer gaps, hand changes, pinches and dragging
cancel the attempt. Swipes, small loops and incomplete arcs do not summon him.
A 12-second cooldown prevents repeat summons. The explicit preview can replay
when its current animation finishes. Hiding the tab clears the effect and cancels
an unfinished gesture; it cannot unexpectedly resume on return.

The effect uses one canvas and the shared animation ticker, with at most 1,100
sparks, batched strokes, cached glow sprites and a 1.5 device-pixel-ratio cap.
Its ticker subscription stops when the camera is off and the effect has ended.
The cameo uses a bundled Sony Pictures publicity still; source and attribution
are recorded in `app/public/images/README.md`. No sound, external request or task
is triggered. Tests cover noisy motion at 10, 15 and 30 fps, lead-in reaches,
brief and prolonged tracking gaps, and accidental-trigger rejection. Sensitivity
still needs evaluation with a physical camera and individual users.
