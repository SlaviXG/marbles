import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAP,
  HandRecorder,
  RECORDING_VERSION,
  installHandRecorder,
  summarize,
  type HandRecorderConsole,
  type HandRowInput,
  type RecordedHand,
  type RecordingDocument,
  type Side,
} from "../handRecorder";

const FRAME = 1000 / 15;

// A plausible upright hand centred near (cx, cy): the wrist below the
// knuckles, palm length about 0.11 of the frame height.
function hand(side: Side, cx: number, cy: number, active = true): RecordedHand {
  const pts = new Array<number>(42);
  for (let i = 0; i < 21; i++) {
    pts[i * 2] = cx + (i % 5) * 0.011 - 0.02;
    pts[i * 2 + 1] = cy - Math.floor(i / 5) * 0.021;
  }
  const put = (i: number, x: number, y: number) => {
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  };
  put(0, cx, cy + 0.08); // wrist
  put(5, cx - 0.03, cy - 0.02); // index knuckle
  put(9, cx, cy - 0.03); // middle knuckle
  put(17, cx + 0.04, cy); // pinky knuckle
  return { hand: side, conf: 0.97, pts, pose: { palm: 0.6, up: 0.95, len: 1.4 }, active };
}

function row(i: number, hands: RecordedHand[], more: Partial<HandRowInput> = {}): HandRowInput {
  return { t: i * FRAME, at: i * FRAME + 80, hands, ...more };
}

describe("HandRecorder", () => {
  it("pushes rows, takes marks and clears", () => {
    const rec = new HandRecorder({ now: () => 1234.56 });
    expect(rec.rows).toEqual([]);
    expect(rec.marks).toEqual([]);

    rec.push(row(0, [hand("R", 0.5, 0.5)], { driver: "R" }));
    rec.push(row(1, [hand("R", 0.5, 0.5)], { driver: "R" }));
    expect(rec.size).toBe(2);
    expect(rec.rows).toHaveLength(2);
    expect(rec.rows[0].driver).toBe("R");

    const m = rec.mark("takeover");
    expect(m).toEqual({ label: "takeover", at: 1234.6, t: rec.rows[1].t, seq: 2 });
    rec.mark("explicit", 2000);
    expect(rec.marks.map((x) => x.label)).toEqual(["takeover", "explicit"]);
    expect(rec.marks[1].at).toBe(2000);

    rec.clear();
    expect(rec.size).toBe(0);
    expect(rec.rows).toEqual([]);
    expect(rec.marks).toEqual([]);
    expect(rec.dropped).toBe(0);
  });

  it("marks before any row carry a null t", () => {
    const rec = new HandRecorder();
    expect(rec.mark("early", 5)).toEqual({ label: "early", at: 5, t: null, seq: 0 });
  });

  it("computes dt from the frame timestamps, 0 for the first row and after clear", () => {
    const rec = new HandRecorder();
    expect(rec.push({ t: 1000, at: 1090, hands: [] }).dt).toBe(0);
    expect(rec.push({ t: 1066.7, at: 1150, hands: [] }).dt).toBeCloseTo(66.7, 5);
    expect(rec.push({ t: 1300, at: 1390, hands: [] }).dt).toBeCloseTo(233.3, 5);
    rec.clear();
    expect(rec.push({ t: 5000, at: 5080, hands: [] }).dt).toBe(0);
  });

  it("records a frame with no hands", () => {
    const rec = new HandRecorder();
    const r = rec.push({ t: 10, at: 95, hands: [], driver: null, why: "", mode: "hand" });
    expect(r.hands).toEqual([]);
    expect(r.driver).toBeNull();
    expect(r.primaryPinching).toBe(false);
    expect(r.secondaryPinching).toBe(false);
    const doc = JSON.parse(JSON.stringify(rec)) as RecordingDocument;
    expect(doc.rows[0].hands).toEqual([]);
    expect(doc.rows[0].mode).toBe("hand");
  });

  it("keeps a rejected hand, and copies what it is given", () => {
    const rec = new HandRecorder();
    const h = hand("L", 0.3, 0.5, false);
    rec.push(row(0, [h, hand("R", 0.7, 0.5)]));
    h.pts[0] = 99;
    h.active = true;
    const stored = rec.rows[0].hands;
    expect(stored).toHaveLength(2);
    expect(stored[0].active).toBe(false);
    expect(stored[0].pts[0]).toBeCloseTo(0.3, 4);
  });

  it("is a ring: at the cap the oldest rows go, and marks older than them", () => {
    const rec = new HandRecorder({ cap: 5 });
    for (let i = 0; i < 3; i++) rec.push(row(i, []));
    rec.mark("old", 2 * FRAME + 81);
    for (let i = 3; i < 7; i++) rec.push(row(i, []));
    rec.mark("recent", 6 * FRAME + 81);
    for (let i = 7; i < 9; i++) rec.push(row(i, []));

    expect(rec.size).toBe(5);
    expect(rec.dropped).toBe(4);
    const ts = rec.rows.map((r) => Math.round(r.t / FRAME));
    expect(ts).toEqual([4, 5, 6, 7, 8]);
    // dt is untouched by the wrap.
    for (const r of rec.rows) expect(r.dt).toBeCloseTo(FRAME, 0);
    expect(rec.marks.map((m) => m.label)).toEqual(["recent"]);
    // seq - dropped indexes the first row after the mark.
    const recent = rec.marks[0];
    expect(Math.round(rec.rows[recent.seq - rec.dropped].t / FRAME)).toBe(7);
    expect(rec.toJSON().dropped).toBe(4);
  });

  it("holds twenty minutes at 15 fps by default", () => {
    expect(new HandRecorder().cap).toBe(DEFAULT_CAP);
    expect(DEFAULT_CAP).toBeGreaterThanOrEqual(20 * 60 * 15);
  });

  it("rounds landmarks and survives a JSON round trip within the tolerance", () => {
    const rec = new HandRecorder({
      meta: () => ({
        userAgent: "test",
        frame: { width: 640, height: 480 },
        params: { pinchOn: 0.04 },
      }),
    });
    const a = hand("R", 0.123456789, 0.987654321);
    a.conf = 0.98765;
    a.pose = { palm: 0.612345, up: 0.954321, len: 1.412345 };
    const input: HandRowInput = {
      t: 1234.5678,
      at: 1320.1234,
      hands: [a, hand("L", 0.4, 0.6, false)],
      driver: "R",
      why: "other still",
      motion: { L: 0.0123456, R: 0.456789 },
      evidence: 0.3333333,
      primaryPinching: true,
      secondaryPinching: false,
      fast: { L: false, R: true },
      mode: "hand",
      extra: { pinchDist: 0.0312, handover: false },
    };
    rec.push(input);
    rec.mark("m1", 1400);

    for (const text of [JSON.stringify(rec), rec.serialize()]) {
      const doc = JSON.parse(text) as RecordingDocument;
      expect(doc.version).toBe(RECORDING_VERSION);
      expect(typeof doc.startedAt).toBe("string");
      expect(Number.isNaN(Date.parse(doc.startedAt))).toBe(false);
      expect(doc.userAgent).toBe("test");
      expect(doc.frame).toEqual({ width: 640, height: 480 });
      expect(doc.params).toEqual({ pinchOn: 0.04 });
      expect(doc.decimals).toBe(4);
      expect(doc.marks).toEqual([{ label: "m1", at: 1400, t: 1234.6, seq: 1 }]);

      const r = doc.rows[0];
      expect(r.t).toBeCloseTo(input.t, 1);
      expect(r.at).toBeCloseTo(input.at, 1);
      expect(r.dt).toBe(0);
      expect(r.hands).toHaveLength(2);
      expect(r.hands[0].hand).toBe("R");
      expect(r.hands[0].pts).toHaveLength(42);
      for (let i = 0; i < 42; i++) {
        expect(Math.abs(r.hands[0].pts[i] - a.pts[i])).toBeLessThanOrEqual(0.5e-4 + 1e-12);
        // At most 4 decimal places in the file.
        expect(String(r.hands[0].pts[i]).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
      }
      expect(r.hands[0].conf).toBeCloseTo(0.988, 6);
      expect(r.hands[0].pose!.palm).toBeCloseTo(0.6123, 6);
      expect(r.hands[0].active).toBe(true);
      expect(r.hands[1].active).toBe(false);
      expect(r.driver).toBe("R");
      expect(r.why).toBe("other still");
      expect(r.motion).toEqual({ L: 0.0123, R: 0.4568 });
      expect(r.evidence).toBe(0.3333);
      expect(r.primaryPinching).toBe(true);
      expect(r.secondaryPinching).toBe(false);
      expect(r.fast).toEqual({ L: false, R: true });
      expect(r.mode).toBe("hand");
      expect(r.extra).toEqual({ pinchDist: 0.0312, handover: false });
    }
  });

  it("takes per-hand evidence, honours `decimals`, and never writes NaN", () => {
    const rec = new HandRecorder({ decimals: 2 });
    const h = hand("R", 0.5, 0.5);
    h.pts[3] = NaN;
    const r = rec.push(row(0, [h], { evidence: { L: 0.126, R: 0.9 }, motion: { R: Infinity } }));
    expect(r.evidence).toEqual({ L: 0.13, R: 0.9 });
    expect(r.motion).toEqual({ R: 0 });
    expect(r.hands[0].pts[3]).toBe(0);
    expect(r.hands[0].pts[0]).toBe(0.5);
    const back = JSON.parse(JSON.stringify(rec)) as RecordingDocument;
    expect(back.rows[0].hands[0].pts.every((v) => typeof v === "number")).toBe(true);
    expect(back.rows[0].motion).toEqual({ R: 0 });
  });

  it("leaves optional fields out of the row, and metadata out of the document", () => {
    const rec = new HandRecorder();
    const r = rec.push(row(0, [hand("R", 0.5, 0.5)]));
    expect(Object.keys(r).sort()).toEqual(
      ["at", "driver", "dt", "hands", "primaryPinching", "secondaryPinching", "t"].sort(),
    );
    const doc = rec.toJSON();
    expect("frame" in doc).toBe(false);
    expect("params" in doc).toBe(false);
    expect("userAgent" in doc).toBe(false);
  });

  it("stays near 1 MB a minute with two hands in frame", () => {
    const rec = new HandRecorder();
    for (let i = 0; i < 15 * 60; i++) {
      const j = Math.sin(i) * 0.01;
      rec.push(
        row(i, [hand("L", 0.31234 + j, 0.5123 - j), hand("R", 0.71234 - j, 0.4871 + j)], {
          driver: "R",
          why: "other still",
          motion: { L: 0.0123, R: 0.2345 },
          evidence: 0.1234,
          fast: { L: false, R: false },
          mode: "hand",
        }),
      );
    }
    expect(rec.serialize().length).toBeLessThan(1.2e6);
  });
});

describe("summarize", () => {
  it("is all zeros for an empty recording", () => {
    const s = summarize([]);
    expect(s.rows).toBe(0);
    expect(s.durationMs).toBe(0);
    expect(s.intervals).toEqual({ count: 0, mean: 0, median: 0, p90: 0, max: 0, over150: 0 });
    expect(s.hands.L.seen).toBe(0);
  });

  it("measures frame intervals", () => {
    const rec = new HandRecorder();
    // Nine intervals of 60 ms and one of 200 ms.
    let t = 0;
    for (let i = 0; i < 11; i++) {
      rec.push({ t, at: t + 80, hands: [] });
      t += i === 4 ? 200 : 60;
    }
    const s = rec.summary();
    expect(s.rows).toBe(11);
    expect(s.durationMs).toBe(740);
    expect(s.noHandFrames).toBe(11);
    expect(s.intervals.count).toBe(10);
    expect(s.intervals.mean).toBeCloseTo(74, 6);
    expect(s.intervals.median).toBe(60);
    expect(s.intervals.max).toBe(200);
    expect(s.intervals.over150).toBe(1);
    expect(s.intervals.p90).toBeCloseTo(74, 6); // between the 9th (60) and 10th (200)
  });

  it("counts seen, active, gate exits, dropouts, a label flip and a duplicate", () => {
    const rec = new HandRecorder({ meta: () => ({ frame: { width: 640, height: 480 } }) });
    const L = (active = true) => hand("L", 0.3, 0.5, active);
    const R = (active = true) => hand("R", 0.7, 0.5, active);
    let i = 0;
    rec.push(row(i++, [L(), R()])); // 0  both
    rec.push(row(i++, [L(), R()])); // 1  both
    rec.push(row(i++, [R()])); //      2  L lost after a two-hand frame
    rec.push(row(i++, [L(), R()])); // 3  both again
    rec.push(row(i++, [L(false), R()])); // 4  L fails the pose gate
    rec.push(row(i++, [L(), R()])); // 5  both
    // 6: the hand on the left is now called R as well: a flip and a duplicate.
    rec.push(row(i++, [hand("R", 0.3, 0.5), R()]));
    rec.push(row(i++, [L(), R()])); // 7  back to normal: L flips back
    rec.push(row(i++, [])); //         8  nothing
    rec.mark("end", 9 * FRAME);

    const s = rec.summary();
    expect(s.rows).toBe(9);
    expect(s.marks).toBe(1);
    expect(s.twoHandFrames).toBe(7);
    expect(s.noHandFrames).toBe(1);

    expect(s.hands.L.seen).toBe(6);
    expect(s.hands.L.active).toBe(5);
    expect(s.hands.R.seen).toBe(8);
    expect(s.hands.R.active).toBe(8);

    expect(s.hands.L.gateExits).toBe(1);
    expect(s.hands.R.gateExits).toBe(0);

    // Seven frames follow a two-hand frame (1, 2, 4, 5, 6, 7, 8). L is gone on
    // 2, 6 (renamed) and 8; R only on 8.
    expect(s.hands.L.missingAfterTwo).toBeCloseTo(3 / 7, 6);
    expect(s.hands.R.missingAfterTwo).toBeCloseTo(1 / 7, 6);

    expect(s.hands.R.labelFlips).toBe(1); // frame 6
    expect(s.hands.L.labelFlips).toBe(1); // frame 7
    expect(s.hands.R.duplicates).toBe(1);
    expect(s.hands.L.duplicates).toBe(0);
  });

  it("does not call a hand that moved, or one seen after a long gap, a flip", () => {
    // R leaves and L appears somewhere else: two different hands.
    const moved = new HandRecorder();
    moved.push(row(0, [hand("R", 0.7, 0.5)]));
    moved.push(row(1, [hand("L", 0.3, 0.5)]));
    expect(moved.summary().hands.L.labelFlips).toBe(0);

    // Same place, other label, but two seconds later.
    const late = new HandRecorder();
    late.push(row(0, [hand("R", 0.7, 0.5)]));
    late.push(row(30, [hand("L", 0.7, 0.5)]));
    expect(late.summary().hands.L.labelFlips).toBe(0);

    // Hands crossing close together keep their own tracks.
    const close = new HandRecorder();
    close.push(row(0, [hand("L", 0.5, 0.5), hand("R", 0.52, 0.5)]));
    close.push(row(1, [hand("L", 0.5, 0.5), hand("R", 0.52, 0.5)]));
    const s = close.summary();
    expect(s.hands.L.labelFlips + s.hands.R.labelFlips).toBe(0);
  });
});

describe("without a DOM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("importing the module and using the core never touches window or document", async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, key) => {
            touched.push(`${name}.${String(key)}`);
            return undefined;
          },
          set: (_t, key) => {
            touched.push(`${name}.${String(key)}=`);
            return true;
          },
          has: (_t, key) => {
            touched.push(`${String(key)} in ${name}`);
            return false;
          },
        },
      );
    vi.stubGlobal("window", trap("window"));
    vi.stubGlobal("document", trap("document"));
    vi.resetModules();

    const mod = await import("../handRecorder");
    const rec = new mod.HandRecorder();
    rec.push(row(0, [hand("R", 0.5, 0.5)]));
    rec.push(row(1, []));
    rec.mark("x");
    rec.summary();
    rec.serialize();
    JSON.stringify(rec);
    rec.clear();
    expect(touched).toEqual([]);
  });

  it("installHandRecorder is a no-op where there is no window", () => {
    expect(typeof window).toBe("undefined");
    const rec = new HandRecorder();
    const uninstall = installHandRecorder(rec);
    expect(typeof uninstall).toBe("function");
    expect(() => uninstall()).not.toThrow();
    expect("__handRec" in globalThis).toBe(false);
  });
});

describe("installHandRecorder", () => {
  // The smallest stand-in for the page that the browser layer needs.
  function fakePage() {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const body: FakeEl[] = [];
    const clicked: FakeEl[] = [];
    interface FakeEl {
      tagName: string;
      style: Record<string, string>;
      textContent: string;
      href?: string;
      download?: string;
      isConnected: boolean;
      setAttribute(): void;
      click(): void;
      remove(): void;
    }
    const createElement = (tag: string): FakeEl => {
      const el: FakeEl = {
        tagName: tag.toUpperCase(),
        style: {},
        textContent: "",
        isConnected: false,
        setAttribute() {},
        click() {
          clicked.push(el);
        },
        remove() {
          el.isConnected = false;
          const i = body.indexOf(el);
          if (i >= 0) body.splice(i, 1);
        },
      };
      return el;
    };
    const win: Record<string, unknown> = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
    };
    const doc = {
      createElement,
      body: {
        appendChild: (el: FakeEl) => {
          el.isConnected = true;
          body.push(el);
        },
      },
    };
    const press = (key: string, mods: Record<string, boolean> = {}) => {
      const e = { key, target: { tagName: "BODY" }, prevented: false, ...mods, preventDefault() {
        e.prevented = true;
      } };
      for (const fn of listeners.get("keydown") ?? []) fn(e);
      return e;
    };
    return { win, doc, body, clicked, press, listeners };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("exposes the console API, binds the keys, shows a toast, and uninstalls", () => {
    const page = fakePage();
    vi.stubGlobal("window", page.win);
    vi.stubGlobal("document", page.doc);
    const made: string[] = [];
    vi.stubGlobal("URL", { createObjectURL: () => (made.push("u"), "blob:x"), revokeObjectURL() {} });

    const rec = new HandRecorder({ now: () => 500 });
    rec.push(row(0, [hand("R", 0.5, 0.5)]));
    const uninstall = installHandRecorder(rec);
    const api = page.win.__handRec as HandRecorderConsole;
    expect(api.rows).toHaveLength(1);
    expect(api.summary().rows).toBe(1);

    // m: auto-numbered marks, with a toast.
    expect(page.press("m").prevented).toBe(true);
    page.press("m");
    expect(api.marks.map((m) => m.label)).toEqual(["m1", "m2"]);
    expect(page.body).toHaveLength(1);
    expect(page.body[0].textContent).toContain("m2");

    // Ignored: with Cmd/Ctrl held, auto-repeat, and while typing in a field.
    page.press("m", { metaKey: true });
    page.press("m", { ctrlKey: true });
    page.press("m", { repeat: true });
    page.press("m", { target: { tagName: "INPUT" } as never });
    expect(page.press("d").prevented).toBe(false); // download needs Shift
    expect(api.marks).toHaveLength(2);
    expect(page.clicked).toHaveLength(0);

    // Shift+D downloads through a temporary anchor.
    page.press("D", { shiftKey: true });
    expect(made).toHaveLength(1);
    expect(page.clicked).toHaveLength(1);
    expect(page.clicked[0].tagName).toBe("A");
    expect(page.clicked[0].download).toMatch(/^hand-recording-\d{8}-\d{6}\.json$/);
    expect(page.clicked[0].isConnected).toBe(false);
    expect(api.download("take1")).toBe("take1.json");
    expect(api.rows).toHaveLength(1); // downloading does not clear

    // Shift+C clears and restarts the mark numbering.
    page.press("C", { shiftKey: true });
    expect(api.rows).toHaveLength(0);
    expect(api.mark().label).toBe("m1");
    expect(api.mark("named").label).toBe("named");

    uninstall();
    expect("__handRec" in page.win).toBe(false);
    expect(page.listeners.get("keydown")!.size).toBe(0);
    expect(page.body).toHaveLength(0);
  });
});
