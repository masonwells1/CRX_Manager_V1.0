/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        crx: {
          green: '#28A26A',
          'green-hover': '#218A5C',
          'green-light': '#E8F5EE',
          'green-tint': '#F0FAF5',
        },
        nav: {
          dark: '#2E2E2E',
          'dark-hover': '#3A3A3A',
        },
        secondary: '#4E4E4E',
        cream: '#F9F7F2',
        'cream-dark': '#F0EDE6',
      },
      fontFamily: {
        heading: ['"Barlow Semi Condensed"', 'sans-serif'],
        sub: ['Inter', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.05)',
        'card-hover': '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.07)',
      },
      spacing: {
        18: '4.5rem',
        88: '22rem',
      },
    },
  },
  plugins: [],
};
