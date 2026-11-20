// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { PreviewSearch } from '../preview-search';

describe('PreviewSearch', () => {
  it('requires minimum query length before searching', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const content = document.createElement('div');
    content.className = 'preview-content';
    content.innerHTML = '<p>short query test</p>';
    
    const search = new PreviewSearch(host);
    search.open(content);
    const input = host.querySelector('.sd-find-input') as HTMLInputElement;
    const count = host.querySelector('.sd-find-count') as HTMLElement;

    expect(input).not.toBeNull();
    expect(count).not.toBeNull();

    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(count.textContent).toContain('Type ≥2 chars');

    input.value = 'xy';
    input.dispatchEvent(new Event('input'));
    expect(count.textContent).not.toContain('Type ≥2 chars');
    
    document.body.removeChild(host);
  });

  it('caps the number of marks created in one search run', () => {
    // Test that the MAX_HITS constant bounds the number of marks created.
    // This test verifies the cap exists and is applied.
    // Stub getBoundingClientRect to return non-zero so marks aren't unwrapped
    const stubRect = { top: 10, left: 10, width: 50, height: 20, bottom: 30, right: 60 } as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(stubRect);
    // Stub scrollIntoView which is not implemented in jsdom
    Element.prototype.scrollIntoView = vi.fn();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const content = document.createElement('div');
    content.className = 'preview-content';
    // Create a document with enough matches to exceed MAX_HITS if unbounded
    const text = 'ab '.repeat(2500);
    content.innerHTML = `<p>${text}</p>`;
    
    const search = new PreviewSearch(host);
    search.open(content);
    const input = host.querySelector('.sd-find-input') as HTMLInputElement;

    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    
    // The cap should limit marks to exactly MAX_HITS (2000)
    const marks = content.querySelectorAll('mark.sd-phit');
    expect(marks.length).toBe(2000);
    const label = host.querySelector('.sd-find-count')?.textContent;
    expect(label).toContain('2000+');
    
    document.body.removeChild(host);
  });

  it('normalizes parent nodes only once per search, not per mark', () => {
    // Test that the linear-time normalize optimization works: each parent is
    // normalized once, not once per mark. Use a spy to count normalize() calls.
    // Stub scrollIntoView which is not implemented in jsdom
    Element.prototype.scrollIntoView = vi.fn();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const content = document.createElement('div');
    content.className = 'preview-content';
    
    // Create multiple paragraphs with multiple matches each
    const paragraphs = Array(10).fill(0).map((_, i) => 
      `<p>Match match match ${i}</p>`
    ).join('');
    content.innerHTML = paragraphs;
    
    const search = new PreviewSearch(host);
    search.open(content);
    const input = host.querySelector('.sd-find-input') as HTMLInputElement;

    input.value = 'match';
    input.dispatchEvent(new Event('input'));
    
    // Set up spy AFTER creating marks, then clear to trigger normalize
    const normalizeSpy = vi.spyOn(Node.prototype, 'normalize');
    input.value = '';
    input.dispatchEvent(new Event('input'));

    // Each <p> should be normalized exactly once when clearing marks
    // 10 paragraphs = 10 normalize calls (content div isn't a mark parent)
    expect(normalizeSpy).toHaveBeenCalledTimes(10);
    
    document.body.removeChild(host);
  });
});
