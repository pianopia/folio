import { Window } from "happy-dom";
export const dom = new Window({ url: "https://folio.example/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLDialogElement: dom.HTMLDialogElement,
});
Object.defineProperty(dom.HTMLDialogElement.prototype, "showModal", {
  value() {
    this.setAttribute("open", "");
  },
});
Object.defineProperty(dom.HTMLDialogElement.prototype, "close", {
  value() {
    this.removeAttribute("open");
  },
});
export const { render, fireEvent, screen, waitFor, cleanup } = await import(
  "@testing-library/react"
);
