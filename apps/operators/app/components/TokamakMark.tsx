/** Tokamak Network brand mark — stylised torus + plasma core,
 *  echoing the donut-shaped chamber the project is named after.
 *  Painted in this app's primary colour via the CSS variable, so
 *  switching the theme palette switches the logo automatically.
 *  Replace the SVG markup here when the official brand SVG drops. */
export function TokamakMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="text-[var(--color-primary)]"
    >
      <ellipse cx="12" cy="12" rx="10" ry="6" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="12" cy="12" rx="4.5" ry="2.5" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
