import { describe, expect, it } from 'vitest';
import { detectPlatform } from '../src/install';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('detectPlatform', () => {
  it('iPhone は ios', () => {
    expect(detectPlatform(IPHONE)).toBe('ios');
  });

  it('デスクトップ表示の iPad（Mac を名乗り、タッチできる）は ios', () => {
    expect(detectPlatform(IPAD_DESKTOP_MODE, 'MacIntel', 5)).toBe('ios');
  });

  it('タッチできない本物の Mac は pc', () => {
    expect(detectPlatform(IPAD_DESKTOP_MODE, 'MacIntel', 0)).toBe('pc');
  });

  it('Android は android', () => {
    expect(detectPlatform(ANDROID)).toBe('android');
  });

  it('Windows は pc', () => {
    expect(detectPlatform(WINDOWS, 'Win32', 0)).toBe('pc');
  });
});
