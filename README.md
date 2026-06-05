# Retro Proxy

This program does two things:

- bypass modern https, which requires encryption that vintage web browsers don't support
- attempts to modify modern web pages to make them usable on vintage web browsers and computer hardware

You can selectively bypass page rewriting for retro-friendly sites by editing `allowed.txt`.

## No-library rewrite

This version runs with **zero npm dependencies**. It uses only Node.js built-in modules.

## Quick Start

```sh
git clone https://github.com/DrKylstein/retro-proxy.git
cd retro-proxy
cp example.env .env
cp allowed.txt.example allowed.txt
node index.js
```

If you still prefer package scripts:

```sh
npm start
```

## Notes

- HTML/CSS rewriting and minification are now implemented with lightweight built-in logic.
- Image transcoding/compression via external libraries has been removed to keep the project dependency-free.
- `SCALE_TO` still adjusts inline `img` width/height when width attributes exist (or sets width when missing).
