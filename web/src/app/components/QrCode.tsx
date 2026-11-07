import qrcode from 'qrcode-generator';

/**
 * A QR code drawn as plain SVG shapes. It is built from React elements, not from an HTML string,
 * because the page forbids string-to-HTML (Trusted Types).
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const quiet = 4; // the blank border scanners need
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (code.isDark(y, x)) cells.push({ x, y });
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size + quiet * 2} ${size + quiet * 2}`}
      className="qr"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#fff" />
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width="1" height="1" fill="#000" />
      ))}
    </svg>
  );
}
