export function abortSignalAfter(milliseconds: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}
