const fs = require('fs');
const path = require('path');

// 1. DIRT TEXTURE GENERATION (16x16 Seamless Grid)
const dirtColors = [
  '#3c2817', // 0: Dark soil
  '#4a331f', // 1: Medium soil
  '#5c3e24', // 2: Normal soil
  '#755132'  // 3: Light soil
];

const dirtGrid = [
  [2,2,1,1,2,2,3,2,1,1,2,2,2,1,1,2],
  [2,1,0,0,1,2,2,2,1,0,0,1,2,2,1,1],
  [1,0,0,0,0,1,3,1,0,0,0,0,1,2,2,2],
  [1,0,1,1,0,1,2,1,0,1,1,0,1,2,3,2],
  [2,1,2,2,1,2,2,2,1,2,2,1,2,2,2,2],
  [2,2,3,2,2,1,1,2,2,2,3,2,2,1,1,2],
  [1,2,2,2,1,0,0,1,2,2,2,2,1,0,0,1],
  [0,1,2,1,0,0,0,0,1,3,2,1,0,0,0,0],
  [0,0,1,1,0,1,1,0,1,2,1,1,0,1,1,0],
  [1,0,1,2,1,2,2,1,2,2,1,2,1,2,2,1],
  [2,1,2,3,2,2,2,2,3,2,2,3,2,2,2,2],
  [2,2,2,2,2,1,1,2,2,2,2,2,2,1,1,2],
  [1,2,2,1,1,0,0,1,2,2,1,1,1,0,0,1],
  [0,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0],
  [0,0,0,0,1,1,1,0,0,0,0,0,1,1,1,0],
  [1,1,1,1,2,2,2,1,1,1,1,1,2,2,2,1]
];

function generateDirtSvg() {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">\n`;
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const colorIdx = dirtGrid[r][c];
      const color = dirtColors[colorIdx];
      svg += `  <rect x="${c}" y="${r}" width="1" height="1" fill="${color}" />\n`;
    }
  }
  svg += `</svg>`;
  return svg;
}

// 2. GRASS TOP BORDER GENERATION (16x16 Horizontal Tileable Grid)
const grassColors = [
  '#4a331f', // 0: Dirt Medium
  '#5c3e24', // 1: Dirt Normal
  '#4c8022', // 2: Shaded Grass Green (Shadows)
  '#5c9e32', // 3: Normal Grass Green
  '#7ebb41'  // 4: Sunlit Grass Green (Highlights)
];

const grassGrid = [
  [4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4], // Row 0: Highlight grass
  [4,3,4,4,3,4,3,4,4,3,4,4,3,4,3,4], // Row 1: Mix highlights & normal
  [3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3], // Row 2: Pure normal grass
  [3,2,3,3,2,3,2,3,3,2,3,3,2,3,2,3], // Row 3: Mix normal & shaded
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2], // Row 4: Shaded grass layer
  [2,1,2,2,1,2,1,2,2,1,2,2,1,2,1,2], // Row 5: Grass to Dirt transition (jagged)
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], // Row 6: Dirt top
  [1,0,1,1,0,1,0,1,1,0,1,1,0,1,0,1], // Row 7: Dirt medium mix
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // Row 8+: Fall into normal dirt values
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
];

function generateGrassTopSvg() {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">\n`;
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const colorIdx = grassGrid[r][c];
      const color = grassColors[colorIdx];
      svg += `  <rect x="${c}" y="${r}" width="1" height="1" fill="${color}" />\n`;
    }
  }
  svg += `</svg>`;
  return svg;
}

// Write the files to public/images
const outputDir = path.join(__dirname, '..', 'apps', 'web', 'public', 'images');

// Ensure directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(path.join(outputDir, 'dirt.svg'), generateDirtSvg());
console.log('Successfully generated dirt.svg in ' + outputDir);

fs.writeFileSync(path.join(outputDir, 'grass_top.svg'), generateGrassTopSvg());
console.log('Successfully generated grass_top.svg in ' + outputDir);
