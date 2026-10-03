// Canvas text styles in the Galmuri pixel fonts. Bitmap fonts stay crisp at their design
// size or exact multiples, so only these sizes are used: 11px, 14px and 22px.

const FALLBACK = ', ui-monospace, Menlo, Consolas, monospace';

export const PX11 = { fontFamily: `Galmuri11${FALLBACK}`, fontSize: '11px' } as const;
export const PX11B = { ...PX11, fontStyle: 'bold' } as const;
export const PX14 = { fontFamily: `Galmuri14${FALLBACK}`, fontSize: '14px' } as const;
export const PX22B = { fontFamily: `Galmuri11${FALLBACK}`, fontSize: '22px', fontStyle: 'bold' } as const;

/** Wait for the fonts before Phaser draws any text (canvas text doesn't re-render on font load). */
export async function loadPixelFonts(): Promise<void> {
  try {
    await Promise.all(['11px Galmuri11', 'bold 11px Galmuri11', '14px Galmuri14'].map((f) => document.fonts.load(f)));
  } catch {
    /* fall back to the monospace stack */
  }
}
