"""Build the original pixel book icon from its editable vector geometry."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / 'assets'
out.mkdir(exist_ok=True)
shapes = [
 ('#38271f', [(3,5),(23,1),(29,6),(29,26),(9,31),(2,25),(2,6)]),
 ('#6b402b', [(4,6),(9,10),(9,28),(4,24)]),
 ('#b77e4c', [(4,5),(23,2),(27,6),(9,10)]),
 ('#e1cda0', [(10,24),(27,20),(27,25),(10,29)]),
 ('#f9edc8', [(10,24),(26,21),(26,23),(10,27)]),
 ('#90603d', [(9,10),(27,6),(27,20),(10,24)]),
 ('#bb8750', [(11,11),(25,8),(25,18),(11,21)]),
 ('#996137', [(13,12),(23,10),(23,17),(13,19)]),
 ('#834034', [(18,9),(21,8),(21,24),(19,22),(18,25)]),
 ('#ba6650', [(18,9),(19,9),(19,22),(18,25)]),
]
im = Image.new('RGBA', (32,32))
draw = ImageDraw.Draw(im)
for fill, points in shapes:
    draw.polygon(points, fill=fill)
large = im.resize((256,256), Image.Resampling.NEAREST)
large.save(out / 'book.png')
large.save(out / 'book.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">'
for fill, points in shapes:
    svg += '<polygon fill="' + fill + '" points="' + ' '.join(f'{x},{y}' for x,y in points) + '"/>'
svg += '</svg>\n'
(out / 'book.svg').write_text(svg, encoding='utf-8')
print(out / 'book.ico')
