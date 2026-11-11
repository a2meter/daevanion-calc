const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const destination = path.join(root, 'dist');
fs.mkdirSync(destination, { recursive: true });
for (const file of ['index.html', 'Nezkhan.html', 'Zikel.html', 'Vaizel.html', 'Triniel.html', 'Lumiel.html']) fs.copyFileSync(path.join(root, file), path.join(destination, file));
for (const directory of ['assets', 'boards']) fs.cpSync(path.join(root, directory), path.join(destination, directory), { recursive: true });
fs.writeFileSync(path.join(destination, '_headers'), '/*.html\n  Cache-Control: no-cache\n/assets/*.js\n  Cache-Control: no-cache\n/boards/*\n  Cache-Control: no-cache\n');
console.log('Cloudflare static assets prepared.');
