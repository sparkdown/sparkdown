import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from '../events';
import { EVENTS, ACTIONS } from '../event-names';

describe('EventBus', () => {
  afterEach(() => vi.restoreAllMocks());

  it('delivers payloads to a subscribed handler', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, handler);

    bus.emit(EVENTS.CONTENT_CHANGED, { content: 'hello' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ content: 'hello' });
  });

  it('fans out to multiple handlers for the same event', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, a);
    bus.on(EVENTS.CONTENT_CHANGED, b);

    bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not invoke handlers for other events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, handler);

    bus.emit(EVENTS.THEME_CHANGED, { theme: 'dark', preference: 'dark' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports payload-less action events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(ACTIONS.SAVE, handler);

    bus.emit(ACTIONS.SAVE);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off() removes a handler', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, handler);
    bus.off(EVENTS.CONTENT_CHANGED, handler);

    bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('off() only removes the given handler, leaving others', () => {
    const bus = new EventBus();
    const keep = vi.fn();
    const drop = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, keep);
    bus.on(EVENTS.CONTENT_CHANGED, drop);
    bus.off(EVENTS.CONTENT_CHANGED, drop);

    bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' });

    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it('dedupes the same handler reference (Set semantics)', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, handler);
    bus.on(EVENTS.CONTENT_CHANGED, handler);

    bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emitting an event with no subscribers is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' })).not.toThrow();
  });

  it('isolates a throwing handler so siblings still run', () => {
    const bus = new EventBus();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(() => {
      throw new Error('handler blew up');
    });
    const after = vi.fn();
    bus.on(EVENTS.CONTENT_CHANGED, boom);
    bus.on(EVENTS.CONTENT_CHANGED, after);

    expect(() => bus.emit(EVENTS.CONTENT_CHANGED, { content: 'x' })).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
