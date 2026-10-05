/**
 * jsdom lacks several browser APIs that CodeMirror and the app depend on.
 * Import this module before anything that instantiates an EditorView.
 */

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// CodeMirror measures text with Range client rects, which jsdom leaves out.
const emptyRectList = () => {
  const list: DOMRect[] & { item?: (i: number) => DOMRect | null } = [] as any;
  list.item = () => null;
  return list as unknown as DOMRectList;
};
Range.prototype.getClientRects = emptyRectList;
Range.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
