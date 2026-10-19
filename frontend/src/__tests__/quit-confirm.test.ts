import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
import { quitConfirmText } from "../app/lifecycle";

describe("quit confirm across windows (#68)", () => {
  it("lists running terminals and unsaved windows in one prompt", () => {
    const t = quitConfirmText({
      busy: [{ window: "p2", command: "sleep 300" }],
      unsaved: ["p1"],
    })!;
    expect(t).toContain("A terminal is still running");
    expect(t).toContain("• sleep 300 — p2");
    expect(t).toContain("Unsaved changes");
    expect(t).toContain("• p1");
  });

  it("asks nothing extra when no terminal is running", () => {
    expect(quitConfirmText({ busy: [], unsaved: ["p1"] })).toBeNull();
  });

  it("caps long lists", () => {
    const busy = Array.from({ length: 10 }, (_, i) => ({
      window: "w",
      command: `c${i}`,
    }));
    const t = quitConfirmText({ busy, unsaved: [] })!;
    expect(t).toContain("10 terminals are");
    expect(t).toContain("…and 2 more");
    expect(t).not.toContain("Unsaved");
  });
});

describe("one quit flow (#88)", () => {
  it("names tmux programs that keep running and does not say it stops them", () => {
    const t = quitConfirmText({
      busy: [{ window: "B", command: "sleep", keeps_running: true }],
      unsaved: ["A"],
    })!;
    expect(t).toContain("• sleep — B (keeps running in tmux)");
    expect(t).toContain("• A");
    expect(t).toContain("Quit SparkDown?");
    expect(t).not.toContain("stop them");
  });
});

describe('a failed job check never reads as "nothing running" (#99)', () => {
  it("lists a window whose check failed and still asks", () => {
    const t = quitConfirmText({
      busy: [
        {
          window: "B",
          command: "",
          keeps_running: true,
          unchecked: "tmux: can't find session",
        },
      ],
      unsaved: ["A"],
    })!;
    expect(t).not.toBeNull();
    expect(t).toContain("Couldn't check these terminals for running programs");
    expect(t).toContain("• B (tmux: can't find session)");
    expect(t).toContain("• A");
    expect(t).toContain("Quit SparkDown anyway?");
    expect(t).not.toContain("still running");
  });

  it("shows running and unchecked terminals together", () => {
    const t = quitConfirmText({
      busy: [
        { window: "B", command: "sleep" },
        { window: "C", command: "", unchecked: "ps did not answer within 3 s" },
      ],
      unsaved: [],
    })!;
    expect(t).toContain("A terminal is still running");
    expect(t).toContain("• sleep — B");
    expect(t).toContain("• C (ps did not answer within 3 s)");
    expect(t).toContain("Quit SparkDown and stop them?");
  });

  it("a rejected quit_status still prompts", async () => {
    const { quitStatusOrUnchecked } = await import("../app/lifecycle");
    const s = await quitStatusOrUnchecked(
      Promise.reject(new Error("busy check failed: boom")),
    );
    expect(s.busy[0].unchecked).toContain("boom");
    expect(quitConfirmText(s)).toContain("every window");
  });

  it("a quit_status that never answers times out and still prompts", async () => {
    const { quitStatusOrUnchecked } = await import("../app/lifecycle");
    const s = await quitStatusOrUnchecked(new Promise(() => {}), 20);
    expect(s.busy[0].unchecked).toContain("no answer");
    expect(quitConfirmText(s)).toContain("Couldn't check");
  });

  it("a healthy answer passes through", async () => {
    const { quitStatusOrUnchecked } = await import("../app/lifecycle");
    const ok = { busy: [{ window: "B", command: "sleep" }], unsaved: ["A"] };
    expect(await quitStatusOrUnchecked(Promise.resolve(ok))).toEqual(ok);
  });
});
