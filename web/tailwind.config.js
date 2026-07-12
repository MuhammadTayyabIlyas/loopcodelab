/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Light, modern palette (base44-style): cool-white surfaces, indigo accent.
        bg: '#f7f8fb',      // page background (very light cool gray)
        panel: '#ffffff',   // cards / primary surfaces
        panel2: '#f1f3f8',  // secondary surfaces (chips, tracks)
        border: '#e5e8ef',  // hairline borders
        muted: '#667085',   // secondary text
        accent: '#6366f1',  // indigo-500
        accent2: '#8b5cf6', // violet-500 (gradients)
        ok: '#16a34a',
        warn: '#d97706',
        danger: '#dc2626',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06)',
        glow: '0 0 0 4px rgba(99,102,241,.12)',
        // Layered "floating" shadow for the hero prompt card (base44-style).
        hero: '0 2px 6px rgba(16,24,40,.05), 0 24px 60px -18px rgba(99,102,241,.22), 0 8px 24px rgba(16,24,40,.07)',
        heroFocus: '0 2px 6px rgba(16,24,40,.05), 0 28px 70px -16px rgba(99,102,241,.32), 0 0 0 4px rgba(99,102,241,.10)',
      },
    },
  },
  plugins: [],
};
