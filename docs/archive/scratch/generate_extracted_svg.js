const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'extracted_grid.json');
const grid = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const h = grid.length;     // 20
const w = grid[0].length;  // 50

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">\n`;

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const color = grid[y][x];
    svg += `  <rect x="${x}" y="${y}" width="1" height="1" fill="${color}" />\n`;
  }
}

svg += `</svg>`;

const outputPath = path.join(__dirname, '..', 'apps', 'web', 'public', 'images', 'minecraft_background.svg');

// Ensure directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, svg);
console.log('Successfully generated minecraft_background.svg from extracted colors at:', outputPath);
