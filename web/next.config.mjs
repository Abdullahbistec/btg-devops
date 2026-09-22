/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse's pdfjs-dist dependency ships an ESM build (pdf.mjs) that
  // Next's webpack bundler can't process in the server/RSC module graph —
  // it throws "Object.defineProperty called on non-object" inside
  // webpack's own __webpack_require__.r module-marking code. Excluding it
  // from bundling makes Node require() it natively at runtime instead,
  // which works correctly. imapflow/mailparser are pure Node and don't
  // need this, but listing them too avoids the same class of bundling
  // surprise if either ever pulls in an ESM-only transitive dependency.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'imapflow', 'mailparser'],
};
export default nextConfig;
