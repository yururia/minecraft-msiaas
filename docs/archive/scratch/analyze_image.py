from PIL import Image
import os

img_path = r"C:\Users\yasud\.gemini\antigravity\brain\e9cf9e64-caf2-4982-8779-6250c41a849e\media__1779372605281.png"
if not os.path.exists(img_path):
    folder = r"C:\Users\yasud\.gemini\antigravity\brain\e9cf9e64-caf2-4982-8779-6250c41a849e"
    files = [f for f in os.listdir(folder) if f.startswith("media__") and f.endswith(".png")]
    files.sort()
    if files:
        img_path = os.path.join(folder, files[-1])

print("Using image:", img_path)
img = Image.open(img_path)
print("Image size:", img.size)
print("Image format:", img.format)
print("Image mode:", img.mode)
