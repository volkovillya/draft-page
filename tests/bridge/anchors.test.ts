// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameBridge } from "@/frame-bridge/bridge";
import { POS_MAX, POS_MIN } from "@/frame-bridge/range";

// jsdom has no layout: every box is 0×0. Elements declare their box via data-box="x y w h".
function fakeLayout() {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const [x = 0, y = 0, w = 0, h = 0] = (this.getAttribute("data-box") ?? "").split(" ").map(Number);
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  });
}

const bridge = frameBridge(false);

describe("CSS path", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header data-box="0 0 800 60"><h1>Title</h1></header>
      <main data-box="0 60 800 900">
        <section data-box="0 60 800 300"><p>one</p><p>two</p></section>
        <section data-box="0 360 800 300">
          <div><span>a</span><em>b</em><span id="target" data-box="100 400 200 50">c</span></div>
          <ul><li>1</li><li>2</li><li class="x">3</li></ul>
        </section>
      </main>`;
  });

  it("builds a body-rooted nth-of-type chain", () => {
    const el = document.getElementById("target")!;
    const { path } = bridge.cssPath(el);
    expect(path).toBe(
      "body > main:nth-of-type(1) > section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(2)",
    );
  });

  it("round-trips every element in the tree", () => {
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const { path, element } = bridge.cssPath(el);
      expect(element).toBe(el);
      expect(document.querySelector(path!)).toBe(el);
    }
  });

  it("has no path for body itself or detached nodes", () => {
    expect(bridge.cssPath(document.body).path).toBeNull();
    expect(bridge.cssPath(document.createElement("div")).path).toBeNull();
  });

  it("falls back to the deepest ancestor when the path would exceed 512 chars", () => {
    let node: HTMLElement = document.body;
    for (let i = 0; i < 60; i++) {
      const child = document.createElement("div");
      node.appendChild(child);
      node = child;
    }
    const { path, element } = bridge.cssPath(node);
    expect(path!.length).toBeLessThanOrEqual(bridge.MAX_PATH);
    expect(element).not.toBe(node);
    expect(element!.contains(node)).toBe(true);
    expect(document.querySelector(path!)).toBe(element);
  });

  describe("anchor → place round trip", () => {
    let spy: ReturnType<typeof fakeLayout>;
    beforeEach(() => {
      spy = fakeLayout();
    });
    afterEach(() => spy.mockRestore());

    it("stores the click as a fraction of the element box and resolves it back", () => {
      const el = document.getElementById("target")!;
      const anchor = bridge.anchorFor(el, 150, 440);
      expect(anchor.targetPath).toContain("span:nth-of-type(2)");
      expect(anchor.posX).toBeCloseTo(0.25);
      expect(anchor.posY).toBeCloseTo(0.8);

      const place = bridge.resolve({ threadId: "t1", ...anchor });
      expect(place).toEqual({ threadId: "t1", x: 150, y: 440, visible: true });

      // The element moves (e.g. layout change): the marker follows it.
      el.setAttribute("data-box", "300 100 400 100");
      expect(bridge.resolve({ threadId: "t1", ...anchor })).toMatchObject({ x: 400, y: 180, visible: true });
    });

    it("hides the marker when the target is gone or the selector is invalid", () => {
      expect(bridge.resolve({ threadId: "t", targetPath: "body > nav:nth-of-type(9)", posX: 0.5, posY: 0.5 }).visible).toBe(false);
      expect(bridge.resolve({ threadId: "t", targetPath: "body >>> ((", posX: 0.5, posY: 0.5 }).visible).toBe(false);
    });

    it("uses document fractions minus scroll when there is no target", () => {
      Object.defineProperty(document.documentElement, "scrollWidth", { configurable: true, value: 1000 });
      Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 4000 });
      const place = bridge.resolve({ threadId: "t", targetPath: null, posX: 0.5, posY: 0.25 });
      expect(place).toEqual({ threadId: "t", x: 500, y: 1000, visible: true });
      // Far from every element (more than one box away): falls back to the document.
      const anchor = bridge.anchorFor(document.body, 500, 3000);
      expect(anchor).toEqual({ targetPath: null, posX: 0.5, posY: 0.75 });
    });

    it("attaches a click on empty space to the nearest element and follows it", () => {
      document.body.innerHTML = `
        <div id="card" data-box="400 200 200 100"><p id="text" data-box="420 220 100 20">hi</p></div>
        <footer id="far" data-box="0 900 1000 40"></footer>`;
      // 50px right of the card, level with its middle: nearest is the card, outside its box.
      const anchor = bridge.anchorFor(document.body, 650, 250);
      expect(anchor.targetPath).toBe("body > div:nth-of-type(1)");
      expect(anchor.posX).toBeCloseTo(1.25);
      expect(anchor.posY).toBeCloseTo(0.5);
      // The card is re-centred by a wider window: the pin moves with it.
      document.getElementById("card")!.setAttribute("data-box", "600 200 200 100");
      expect(bridge.resolve({ threadId: "t", ...anchor })).toMatchObject({ x: 850, y: 250, visible: true });
    });

    it("prefers the closest, then the smallest, element for empty-space clicks", () => {
      document.body.innerHTML = `
        <section data-box="0 0 1000 600"><div id="a" data-box="100 100 50 50"></div></section>`;
      // Inside the section's box (distance 0), so the section wins over the farther small div.
      expect(bridge.anchorFor(document.documentElement, 500, 500).targetPath).toBe("body > section:nth-of-type(1)");
    });

    it("clamps stored positions to the shared range", () => {
      expect([bridge.POS_MIN, bridge.POS_MAX]).toEqual([POS_MIN, POS_MAX]);
      const el = document.getElementById("target")!;
      expect(bridge.resolve({ threadId: "t", targetPath: bridge.cssPath(el).path, posX: 9, posY: -9 })).toMatchObject({
        x: 100 + 2 * 200,
        y: 400 - 1 * 50,
      });
    });
  });
});

describe("visibility", () => {
  let spy: ReturnType<typeof fakeLayout>;
  beforeEach(() => {
    spy = fakeLayout();
    document.body.innerHTML = `
      <div id="plain" data-box="0 0 10 10"></div>
      <div id="empty"></div>
      <div style="display:none"><p id="in-none" data-box="0 0 10 10">x</p></div>
      <div style="visibility:hidden">
        <p id="in-hidden" data-box="0 0 10 10">x</p>
        <p id="opt-back-in" style="visibility:visible" data-box="0 0 10 10">x</p>
      </div>
      <p id="self-hidden" style="visibility:hidden" data-box="0 0 10 10">x</p>
      <div style="opacity:0"><span id="in-transparent" data-box="0 0 10 10">x</span></div>
      <div style="opacity:0.2"><div style="opacity:0.2"><span id="compound" data-box="0 0 10 10">x</span></div></div>
      <div style="opacity:0.5"><span id="half" data-box="0 0 10 10">x</span></div>`;
  });
  afterEach(() => spy.mockRestore());

  const visible = (id: string) => bridge.isVisible(document.getElementById(id)!);

  it("treats a normal, sized element as visible", () => {
    expect(visible("plain")).toBe(true);
    expect(visible("half")).toBe(true);
    expect(visible("opt-back-in")).toBe(true);
  });

  it("hides zero-size boxes", () => {
    expect(visible("empty")).toBe(false);
  });

  it("hides elements under a display:none ancestor", () => {
    expect(visible("in-none")).toBe(false);
  });

  it("hides visibility:hidden elements, including inherited", () => {
    expect(visible("self-hidden")).toBe(false);
    expect(visible("in-hidden")).toBe(false);
  });

  it("hides elements whose effective opacity is below 0.05", () => {
    expect(visible("in-transparent")).toBe(false);
    expect(visible("compound")).toBe(false); // 0.2 × 0.2 = 0.04
  });

  it("resolve() reports hidden targets as not visible", () => {
    const path = bridge.cssPath(document.getElementById("in-none")!).path!;
    expect(bridge.resolve({ threadId: "t", targetPath: path, posX: 0, posY: 0 })).toEqual({
      threadId: "t",
      x: 0,
      y: 0,
      visible: false,
    });
  });
});

describe("message tagging", () => {
  it("tags payloads with dp: 1 and the type", () => {
    expect(bridge.tag("scroll", { x: 1, y: 2 })).toEqual({ dp: 1, type: "scroll", x: 1, y: 2 });
  });
});
