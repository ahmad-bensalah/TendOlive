/** OliveSoft design tokens (see docs/design/Product_UX_and_Design_System.md). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#2557F2', hover: '#1D47CC', soft: '#EAF0FF', deep: '#16348F' },
        olive: { DEFAULT: '#6B8E23', soft: '#EEF4E2', deep: '#3F5A14' },
        ink: { DEFAULT: '#0F172A', muted: '#64748B', faint: '#94A3B8' },
        canvas: '#F3F6FB',
        line: '#E4E9F2',
        warn: { DEFAULT: '#D97706', soft: '#FEF3E2' },
        bad: { DEFAULT: '#DC2626', soft: '#FDECEC' },
      },
      fontFamily: { sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { card: '16px', ctl: '10px' },
      boxShadow: { card: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 1px rgb(15 23 42 / 0.02)', pop: '0 12px 40px rgb(15 23 42 / 0.12)' },
    },
  },
  plugins: [],
}
