/** @type {import('tailwindcss').Config} */
// Gatherwell tokens — Modern Sage + Deep Navy. Use brand-*, mist-*, ink, gold-*; never raw blue/slate.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
      colors: {
        brand: { 50: '#EEF4F1', 100: '#DCE8E2', 200: '#B7D0C4', 300: '#8CB2A1', 400: '#5E8F7A', 500: '#477562', 600: '#30604F', 700: '#244E43', 800: '#1B3D34', 900: '#132C26', DEFAULT: '#244E43' },
        mist: { 50: '#F6F7F3', 100: '#EDEFE9', 200: '#E0E3DB', 300: '#BCC2B9', 400: '#69736E', 500: '#56605B', 600: '#454E4A', 700: '#343C39', 800: '#26302C', 900: '#1A2220' },
        ink: { DEFAULT: '#243447', soft: '#3A4A5D', faint: '#5B6878' },
        gold: { 50: '#FBF6EE', 100: '#F5ECDD', 200: '#E9D6B4', 500: '#C69B55', 700: '#8A6A33' },
        ivory: '#F6F7F3',
      },
      borderRadius: { card: '12px' },
      boxShadow: {
        card: '0 1px 2px rgba(36, 52, 71, 0.04)',
        pop: '0 16px 40px -12px rgba(36, 52, 71, 0.22)',
      },
      maxWidth: { page: '1180px' },
    },
  },
  plugins: [],
}
