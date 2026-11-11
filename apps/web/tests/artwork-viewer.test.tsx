import { test, expect, afterEach } from "bun:test";
import React, { useState } from "react";
import type { Artwork } from "@folio/shared";
import ArtworkViewer from "../app/ui/ArtworkViewer";
import { render, fireEvent, screen, cleanup } from "./dom";
const artworks: Artwork[] = ["Landscape", "Portrait"].map((title, index) => ({
  id: String(index),
  title,
  url: `https://example.com/${index}.png`,
  groupId: "private",
  collection: "Photos",
  tags: [],
  favorite: false,
  createdAt: "2026-11-12",
  source: "sample",
}));
afterEach(cleanup);
test("image takes centre stage; details are opt-in, keyboard navigation ignores form inputs, and changing images hides details", () => {
  let copies = 0,
    closes = 0;
  function Gallery() {
    const [index, setIndex] = useState(0);
    return (
      <ArtworkViewer
        art={artworks[index]}
        index={index}
        count={2}
        onNavigate={(direction) => setIndex((i) => (i + direction + 2) % 2)}
        onClose={() => closes++}
        onCopy={() => copies++}
      >
        <form>
          <label>
            タイトル
            <input defaultValue={artworks[index].title} />
          </label>
        </form>
      </ArtworkViewer>
    );
  }
  render(<Gallery />);
  expect(screen.getByRole("dialog", { name: "Artwork details" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Landscape" })).toBeTruthy();
  expect(screen.queryByLabelText("タイトル")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "作品の詳細情報" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("閉じる");
  fireEvent.click(screen.getByRole("button", { name: "次の作品" }));
  expect(screen.getByRole("img", { name: "Portrait" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "作品の詳細情報" }));
  expect(screen.getByRole("region", { name: "作品の詳細" })).toBeTruthy();
  const field = screen.getByLabelText("タイトル");
  fireEvent.keyDown(field, { key: "ArrowLeft" });
  expect(screen.getByRole("img", { name: "Portrait" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(screen.getByRole("img", { name: "Landscape" })).toBeTruthy();
  expect(screen.queryByLabelText("タイトル")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "画像をコピー" }));
  expect(copies).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(closes).toBe(1);
});
test("a single artwork disables navigation; the info icon toggles the panel and feedback remains visible without it", () => {
  let navigations = 0;
  render(
    <ArtworkViewer
      art={artworks[0]}
      index={0}
      count={1}
      onNavigate={() => navigations++}
      onClose={() => {}}
      onCopy={() => {}}
      feedback="画像をコピーしました"
    >
      <p>非公開の詳細</p>
    </ArtworkViewer>,
  );
  expect(
    (screen.getByRole("button", { name: "前の作品" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "次の作品" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(navigations).toBe(0);
  expect(screen.getByRole("status").textContent).toBe("画像をコピーしました");
  fireEvent.click(screen.getByRole("button", { name: "作品の詳細情報" }));
  expect(screen.getByText("非公開の詳細")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "詳細情報を閉じる" }));
  expect(screen.queryByText("非公開の詳細")).toBeNull();
});
