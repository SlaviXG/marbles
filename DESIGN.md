# Holographic agent interface

An office worker directs a projected team through voice and short hand gestures. Use one restrained, cinematic holographic space inspired by Tony Stark's JARVIS: deep blue-black surfaces, cyan light, precise fine rings, subtle projection depth and readable labels. No cute animals, office scenery, dashboard tabs, typed composer or button bars.

The voice core is a reactor of light at the foot of the room (`VoiceCore`): a bar ring that follows the microphone, a shockwave when the wake word lands, cyan while listening and amber while speaking. It starts and pauses both microphone and camera, and the room answers it (frame brackets tighten, canvas rings brighten). Spoken exchanges appear as subtitles above it: only the latest request and reply, dissolving once heard, never a chat log. Agent cores animate from actual task state: quiet breathing while waiting, rotating segmented rings while working, a short completion pulse and checkmark when finished, and an amber warning when a task needs attention. Positions stay fixed for gesture targeting. Reduced motion keeps static state glyphs.

Keep a gesture recognition widget visible before and after activation. Show camera status, mirrored live hand outlines, pinch and two-hand zoom feedback, mouse takeover, and actionable camera errors. Use the same orb to start and pause tracking. Keep the widget compact while a result is being presented and above the main canvas on narrow screens.

Represent outputs as small holographic document, grid, image or slide objects. Multiple deliverables form one file stack next to their creator. Point and pinch opens a readable detail surface. Known filenames can be opened by voice without starting another task. Technical activity is secondary, and details never dismiss because the pointer leaves.

Use system sans for reading text and a DIN-style face (`--hud`: DIN Alternate, Bahnschrift) in small tracked capitals for labels. Keep words to a minimum: one or two per label, hints only when something needs doing. Generous gesture targets, and no fake metrics, decorative terminal output or dense controls. The page opens with a short warm-up (a ring of light, then the room); aiming at anything draws lock-on brackets.

Start with a wider field of view and generous spacing so users can explore by hand and make room for more assets. Keep asset previews inside the canvas: native page rendering for PDF, embedded image/media and static HTML views, tables for spreadsheet data, and readable document/slide content. Never send selection to another browser tab or default app.

## Result presentation lifecycle

New completed tasks with generated files enter a queue. The presenting agent moves from its stable home slot to a dock beside a floating screen, which unfolds from the agent with a luminous tether. The screen uses real inline asset readers. File switching keeps the presenter docked. Closing by pinch, Escape or voice folds the screen back first, then returns the agent to its central home slot. The next queued result can present after the return finishes. Existing history does not auto-open on page load, and a new completion never takes over a detail surface already being read. Reduced motion uses the same lifecycle with immediate state changes. The unfold is three beats: a spark at the agent, a line of light across the room, then the screen opens and each file is printed on by one scanner pass. A cone of light from the agent stays on the screen while it is open, files in one result sit in a strip of chips along the bottom, and Markdown is rendered as a formatted briefing.

## Shown by voice

Marbles (Hermes) can put things in front of the user directly, without starting a task: open any agent, its files, a task, a team, a file or a note; show pictures from the web; play a YouTube video. These land on the media stage, which opens out of the voice core the way a result opens out of its agent. Nothing leaves the app: no new tabs.

Email and calls are never automatic. Hermes prepares a card (recipient, subject, body, or the number), and it is sent or dialled only after the user says “send it” / “call” or pinches the button. They go through the Mac's own Mail, Contacts and phone handler, so there are no accounts to configure.

Documents read as documents: Markdown with typeset LaTeX and inline pictures, `.tex` sources, presentations as slides, workbooks as tables. Workers build real `.pptx` and `.xlsx` files with `app/scripts/make-office.mjs`.

A working agent shows real progress only: a dial that laps once a minute of actual elapsed time, a timer, and the latest readable line the worker printed. No invented percentages.

## Moving things, and waiting your turn

Everything projected can be picked up: pinch (or press) a window's title bar and move it; pinch a teammate or a file on the canvas, hold, and carry it, with its files following. A short pinch still opens; only a held move carries.

A video plays in a small side window that blocks nothing and can be dragged or enlarged, so work continues around it.

Work queues instead of failing or being dropped. One sentence can hold several tasks and each is delegated; tasks that cannot start wait at the centre of the canvas ("2 queued") and start in order as agents free up. Finished results queue too: a result on screen is never replaced or closed by a stray pinch on the canvas. It closes on its button, Escape or by voice, and the waiting one is a "Next" away.
