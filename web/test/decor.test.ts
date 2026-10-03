import { describe, expect, it } from 'vitest';
import { skyAt } from '../src/decor';

const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m);

describe('skyAt', () => {
  it('follows the PC clock through dawn, day, sunset and night', () => {
    expect(skyAt(at(6)).stars).toBe(false);
    expect(skyAt(at(12)).floorDim).toBe(0); // bright office at noon
    expect(skyAt(at(18)).color).toBe(skyAt(at(17, 30)).color); // sunset window
    expect(skyAt(at(22)).stars).toBe(true);
    expect(skyAt(at(3)).stars).toBe(true);
    expect(skyAt(at(5, 29)).stars).toBe(true);
    expect(skyAt(at(5, 31)).stars).toBe(false);
  });
});
