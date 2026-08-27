import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'off-white': '#efeeec',
        'dark-gray': '#191919',
        purple: '#734e9e',
        'd-purple': '#5f4082',
        'd-yellow': '#d09846',
        yellow: '#fdbb1c',
        green: '#5cbd7d',
        'green-pale': '#d0f2dc',
        red: '#fc1c67',
        'pink-pale': '#ff76a4',
      },
      fontFamily: {
        display: ['"Bebas Neue Pro"', '"Oswald BTRL"', '"Arial Narrow"', 'sans-serif'],
        body: ['"Cabin BTRL"', 'system-ui', 'sans-serif'],
        data: ['"Barlow Condensed BTRL"', '"Oswald BTRL"', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', '"Roboto Mono"', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
      },
    },
  },
  plugins: [],
} satisfies Config;
