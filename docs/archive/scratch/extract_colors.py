from PIL import Image
import json

img_path = r"C:\Users\yasud\.gemini\antigravity\brain\e9cf9e64-caf2-4982-8779-6250c41a849e\media__1779372605281.png"
img = Image.open(img_path)

img_rgb = img.convert("RGB")

# 50x20 pixels
w, h = 50, 20
resized = img_rgb.resize((w, h), Image.Resampling.NEAREST)

grid = []
for y in range(h):
    row = []
    for x in range(w):
        r, g, b = resized.getpixel((x, y))
        hex_color = f"#{r:02x}{g:02x}{b:02x}"
        row.append(hex_color)
    grid.append(row)

output_path = r"c:\Users\yasud\OneDrive\デスクトップ\個人用\minecraft-msiaas\scratch\extracted_grid.json"
with open(output_path, "w") as f:
    json.dump(grid, f, indent=2)

print("Successfully extracted grid color codes of size 50x20 and saved to:", output_path)
