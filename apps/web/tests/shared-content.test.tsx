import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { initialArtworks } from "@folio/shared";
import SharedArtworkActions from "../app/ui/SharedArtworkActions";
import { cleanup, fireEvent, render, screen, waitFor } from "./dom";

const art = { ...initialArtworks[0], ownerId: "other-user" };
const originalFetch = globalThis.fetch;
const originalPrompt = Object.getOwnPropertyDescriptor(window, "prompt");
const originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm");
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (originalPrompt) Object.defineProperty(window, "prompt", originalPrompt);
  else Reflect.deleteProperty(window, "prompt");
  if (originalConfirm)
    Object.defineProperty(window, "confirm", originalConfirm);
  else Reflect.deleteProperty(window, "confirm");
});

test("report trims the reason and waits for confirmation; cancel and invalid reasons send nothing", async () => {
  const sent: { path: string; init?: RequestInit }[] = [];
  const feedback: string[] = [];
  globalThis.fetch = (async (path, init) => {
    sent.push({ path: String(path), init });
    return Response.json({ id: "report" }, { status: 201 });
  }) as typeof fetch;
  const prompt = mock((): string | null => null);
  const confirm = mock(() => false);
  Object.defineProperty(window, "prompt", {
    configurable: true,
    value: prompt,
  });
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: confirm,
  });
  render(
    <SharedArtworkActions
      art={art}
      onBlocked={async () => {
        throw Error("unexpected block");
      }}
      notify={(message) => feedback.push(message)}
    />,
  );
  const button = screen.getByRole("button", { name: "通報" });
  prompt.mockReturnValueOnce(null);
  fireEvent.click(button);
  prompt.mockReturnValueOnce(" ");
  fireEvent.click(button);
  prompt.mockReturnValueOnce("x".repeat(1001));
  fireEvent.click(button);
  prompt.mockReturnValueOnce("理由");
  confirm.mockReturnValueOnce(false);
  fireEvent.click(button);
  expect(sent).toHaveLength(0);
  prompt.mockReturnValueOnce("  確認してください  ");
  confirm.mockReturnValueOnce(true);
  fireEvent.click(button);
  await waitFor(() =>
    expect(feedback.at(-1)).toBe("通報を受け付けました。内容を確認します。"),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].path).toBe(`/api/artworks/${art.id}/reports`);
  expect(sent[0].init?.method).toBe("POST");
  expect(JSON.parse(String(sent[0].init?.body))).toEqual({
    reason: "確認してください",
  });
});

test("block requires confirmation and refreshes only after a successful API response", async () => {
  const owners: string[] = [],
    feedback: string[] = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(
      calls === 1 ? { error: "再試行してください" } : { blocked: true },
      { status: calls === 1 ? 503 : 201 },
    );
  }) as typeof fetch;
  const confirm = mock(() => false);
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: confirm,
  });
  render(
    <SharedArtworkActions
      art={art}
      onBlocked={async (id) => {
        owners.push(id);
      }}
      notify={(message) => feedback.push(message)}
    />,
  );
  const button = screen.getByRole("button", { name: "ブロック" });
  confirm.mockReturnValueOnce(false);
  fireEvent.click(button);
  expect(calls).toBe(0);
  confirm.mockReturnValueOnce(true);
  fireEvent.click(button);
  await waitFor(() => expect(feedback).toEqual(["再試行してください"]));
  expect(owners).toEqual([]);
  confirm.mockReturnValueOnce(true);
  fireEvent.click(button);
  await waitFor(() => expect(owners).toEqual([art.ownerId]));
  expect(calls).toBe(2);
});
