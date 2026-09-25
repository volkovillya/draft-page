// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frameBridge } from "@/frame-bridge/bridge";

/** Runs the serialized bridge in a fresh "frame" window whose parent records messages. */
function mountFrame(body: string) {
  const frame = new JSDOM(`<!doctype html><body>${body}</body>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const parent = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const win = frame.window;
  const sent: Record<string, unknown>[] = [];
  parent.window.postMessage = ((data: Record<string, unknown>) => void sent.push(data)) as typeof win.postMessage;
  Object.defineProperty(win, "parent", { configurable: true, get: () => parent.window });

  // No layout in jsdom: boxes come from data-box="x y w h".
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const [x = 0, y = 0, w = 0, h = 0] = (this.getAttribute("data-box") ?? "").split(" ").map(Number);
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  };

  win.eval(`(${frameBridge.toString()})()`);

  const fromParent = (data: unknown, source: unknown = parent.window) =>
    win.dispatchEvent(new win.MessageEvent("message", { data, source: source as Window }));
  const close = () => {
    frame.window.close();
    parent.window.close();
  };
  return { win, doc: win.document, sent, fromParent, close };
}

describe("bridge runtime", () => {
  let f: ReturnType<typeof mountFrame>;
  beforeEach(() => {
    f = mountFrame(`<main data-box="0 0 800 600"><button id="b" data-box="100 100 200 40">Go</button></main>`);
  });
  afterEach(() => f.close());

  it("announces ready, tagged", () => {
    expect(f.sent[0]).toMatchObject({ dp: 1, type: "ready" });
  });

  it("answers locate with places, including hidden ones", () => {
    const path = "body > main:nth-of-type(1) > button:nth-of-type(1)";
    f.fromParent({
      dp: 1,
      type: "locate",
      anchors: [
        { threadId: "a", targetPath: path, posX: 0.5, posY: 0.5 },
        { threadId: "b", targetPath: "body > aside:nth-of-type(1)", posX: 0.5, posY: 0.5 },
      ],
    });
    expect(f.sent.at(-1)).toEqual({
      dp: 1,
      type: "places",
      places: [
        { threadId: "a", x: 200, y: 120, visible: true },
        { threadId: "b", x: 0, y: 0, visible: false },
      ],
    });
  });

  it("ignores messages that aren't from the parent, untagged, or malformed", () => {
    const before = f.sent.length;
    const anchors = [{ threadId: "a", targetPath: null, posX: 0.5, posY: 0.5 }];
    f.fromParent({ dp: 1, type: "locate", anchors }, f.win); // wrong source
    f.fromParent({ type: "locate", anchors }); // untagged
    f.fromParent({ dp: 1, type: "locate", anchors: [{ threadId: 5, targetPath: null, posX: 0, posY: 0 }] });
    f.fromParent({ dp: 1, type: "locate", anchors: [{ threadId: "a", targetPath: null, posX: Number.NaN, posY: 0 }] });
    expect(f.sent.length).toBe(before);
  });

  it("in placing mode, swallows the page's click and emits pick", () => {
    let pageSawClick = false;
    const button = f.doc.getElementById("b")!;
    button.addEventListener("click", () => {
      pageSawClick = true;
    });

    f.fromParent({ dp: 1, type: "mode", placing: true });
    expect(f.doc.documentElement.hasAttribute("data-dp-placing")).toBe(true);

    const click = new f.win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 150, clientY: 130 });
    button.dispatchEvent(click);

    expect(pageSawClick).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(f.sent.at(-1)).toEqual({
      dp: 1,
      type: "pick",
      posX: 0.25,
      posY: 0.75,
      targetPath: "body > main:nth-of-type(1) > button:nth-of-type(1)",
      clientX: 150,
      clientY: 130,
    });

    f.fromParent({ dp: 1, type: "mode", placing: false });
    expect(f.doc.documentElement.hasAttribute("data-dp-placing")).toBe(false);
    const before = f.sent.length;
    button.dispatchEvent(new f.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pageSawClick).toBe(true);
    expect(f.sent.length).toBe(before);
  });
});
