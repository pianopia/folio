import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import React from "react";
import UploadPanel from "../app/ui/UploadPanel";
import { render, fireEvent, screen, waitFor, cleanup } from "./dom";
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
let uploaded: string[] = [],
  completed: string[] = [],
  failed = new Set<string>(),
  urls = 0;
class UploadXHR {
  upload: {
    onprogress?: (e: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
  } = {};
  withCredentials = false;
  timeout = 0;
  status = 200;
  responseText = "";
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  open() {}
  setRequestHeader() {}
  send(form: FormData) {
    const file = form.get("file") as File;
    uploaded.push(file.name);
    setTimeout(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: 10,
        total: 10,
      });
      this.status = failed.has(file.name) ? 502 : 201;
      this.responseText = JSON.stringify(
        this.status === 201
          ? { id: file.name, title: file.name, source: "storage" }
          : { error: "保存失敗" },
      );
      this.onload?.();
    }, 0);
  }
}
const image = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, {
    type: "image/png",
    lastModified: 1,
  });
async function setup() {
  render(
    <UploadPanel
      groups={[{ id: "private", name: "Personal", color: "green" }]}
      onUploaded={(art) => completed.push(art.id)}
    />,
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("アップロードする画像") as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  return screen.getByLabelText("アップロードする画像");
}
beforeEach(() => {
  uploaded = [];
  completed = [];
  failed = new Set();
  globalThis.fetch = (async () =>
    Response.json({
      destination: "storage",
      canUpload: true,
      reauthRequired: false,
      maxBytes: 20 * 1024 * 1024,
    })) as unknown as typeof fetch;
  globalThis.XMLHttpRequest = UploadXHR as unknown as typeof XMLHttpRequest;
  URL.createObjectURL = () => `blob:preview-${++urls}`;
  URL.revokeObjectURL = () => {};
});
afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

test("select multiple images, inspect full preview, navigate, remove one and upload the remaining images with one action", async () => {
  const input = await setup();
  fireEvent.change(input, {
    target: {
      files: [image("first.png"), image("second.png"), image("third.png")],
    },
  });
  expect(uploaded).toHaveLength(0);
  fireEvent.click(
    screen.getByRole("button", { name: "first.pngを大きくプレビュー" }),
  );
  expect(screen.getByRole("dialog", { name: "first.png" })).toBeTruthy();
  expect(screen.getByText(/未アップロード/)).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByRole("dialog", { name: "second.png" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "この画像を選択から外す" }),
  );
  expect(screen.getByRole("dialog", { name: "third.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "プレビューを閉じる" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(uploaded).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "アップロード（2）" }));
  await waitFor(() => expect(completed).toEqual(["first.png", "third.png"]));
  expect(uploaded).toEqual(["first.png", "third.png"]);
  fireEvent.click(
    screen.getByRole("button", { name: "first.pngを大きくプレビュー" }),
  );
  expect(screen.getByText(/MB · アップロード済み/)).toBeTruthy();
});

test("additional selection and drops keep existing images, deduplicate and enforce the combined ten-image limit", async () => {
  const input = await setup();
  fireEvent.change(input, {
    target: { files: [image("first.png"), image("second.png")] },
  });
  fireEvent.change(input, {
    target: { files: [image("second.png"), image("third.png")] },
  });
  expect(
    screen.getByRole("button", { name: "アップロード（3）" }),
  ).toBeTruthy();
  fireEvent.drop(input.parentElement!, {
    dataTransfer: { files: [image("fourth.png")] },
  });
  expect(
    screen.getByRole("button", { name: "アップロード（4）" }),
  ).toBeTruthy();
  fireEvent.change(input, {
    target: {
      files: Array.from({ length: 7 }, (_, i) => image(`more-${i}.png`)),
    },
  });
  expect(screen.getByRole("alert").textContent).toContain("合計10枚まで");
  expect(
    screen.getByRole("button", { name: "アップロード（4）" }),
  ).toBeTruthy();
  expect(uploaded).toHaveLength(0);
});

test("one file failing does not stop the batch, and retry only sends failed files", async () => {
  const input = await setup();
  failed.add("second.png");
  fireEvent.change(input, {
    target: {
      files: [image("first.png"), image("second.png"), image("third.png")],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "アップロード（3）" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "アップロード（1）" }),
    ).toBeTruthy(),
  );
  expect(completed).toEqual(["first.png", "third.png"]);
  failed.clear();
  fireEvent.click(screen.getByRole("button", { name: "アップロード（1）" }));
  await waitFor(() =>
    expect(completed).toEqual(["first.png", "third.png", "second.png"]),
  );
  expect(uploaded).toEqual([
    "first.png",
    "second.png",
    "third.png",
    "second.png",
  ]);
});
