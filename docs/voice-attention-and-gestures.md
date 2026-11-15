# Voice, attention and gestures

How Marbles decides when to listen, what to ignore, what it remembers, and what
your hands can do. Everything here runs in the browser unless it says otherwise.

## When the microphone is open

Marbles is always in one of three states.

| State | What it means | How you get there |
| --- | --- | --- |
| Waiting | Audio stays on this device. Only the local wake-word detector hears it. | The default once the orb is on. |
| Armed | Ready for a request. Speech is sent to the transcriber when you start talking. | Say "Marbles", **or look at the screen**. |
| Listening | You are speaking; your words are being transcribed. | Start talking while armed. |

It returns to Waiting when you stop engaging: a few seconds after you look away,
or when the short window after the wake word runs out. A new phrase extends the
window. Continuous sound does not.

### Looking at the screen (head pose)

When the orb is on, a second, small camera stream watches for faces.

1. MediaPipe's face landmarker runs in a worker, about six times a second, on a
   256-pixel-wide frame.
2. The **nearest person** is chosen: the largest face in view.
3. That face's transformation matrix gives the direction the head points. Yaw
   and pitch are read from it (`src/attention/headPose.ts`).
4. You count as looking when the head is within 24° sideways and 22° up or down
   of straight at the camera. Once you are looking, the cone widens by a quarter
   so a nod or a glance at the keyboard does not drop you.
5. Timing smooths it: 0.3 s of looking to engage, 1.4 s of looking away to
   release, 2 s with no face before "nobody is there".

Looking arms the microphone exactly as the wake word does. The gesture panel
shows **Eyes on** or **Looking away** while a face is tracked.

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
4. **Attention.** With head pose on, sound only becomes a request while you are
   looking at the screen or just after the wake word.

Known limits:

- Sound from **other apps** (a music player outside the browser) is not covered
  by echo cancellation on every system. Background detection and attention are
  what handle it.
- A song with long pauses, or speech-like audio such as a podcast, can still be
  transcribed while you are looking at the screen. Hermes is told it may ignore
  background speech, which catches much of the rest.
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
| Pinch the × on a window | Closes it. |

There is no gesture that closes a window by itself: a fast open hand looks
like pointing, and dropping the hands looks like resting, so both closed
things by accident.

While a document is open the cursor is steadied against hand tremor. That
steadying is switched off for the length of a drag, so what you carry follows
your hand exactly.

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

Hermes only drafts. When you confirm, a worker agent (Claude first, otherwise
Codex) sends the message **with its own Gmail connector**, exactly as written,
and must end with an explicit verdict: sent, no Gmail available, or failed. The
card shows which. If the agent has no Gmail connector signed in, nothing is
sent and the card offers **Send with Mail** (the Mac's Mail app) instead.

- The Claude worker is allowed the `mcp__claude_ai_Gmail` tools for that task.
- Set `MARBLES_EMAIL_VIA=mail` to always use Mail.
- A connector added in the Claude or ChatGPT apps is not automatically available
  to the command-line agents Marbles runs. Check with
  `claude -p "which Gmail tools do you have?"`.
