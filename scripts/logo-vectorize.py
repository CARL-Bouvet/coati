# Vectorize CoatiLogo2.png -> coati.svg (transparent background) with an explicit eye contour.
from PIL import Image, ImageFilter, ImageDraw
import numpy as np, vtracer, re, math
P=['#F7F5F1','#050403','#9C5A12','#7A4610','#C08A50','#E2C29C','#C0BFBD','#7A7878','#E2DEDB','#3A2E2D']
pal=np.array([[int(h[i:i+2],16) for i in (1,3,5)] for h in P],float)
img=Image.open(".tmp/logo/trace_in.png").convert("RGB")
a=np.array(img).astype(float); H,W,_=a.shape; f=a.reshape(-1,3)
lab=np.concatenate([((f[i:i+300000,None,:]-pal[None])**2).sum(2).argmin(1) for i in range(0,len(f),300000)])
q=Image.fromarray(pal[lab].reshape(H,W,3).astype(np.uint8)).filter(ImageFilter.ModeFilter(5))
for pt in [(0,0),(W-1,0),(0,H-1),(W-1,H-1)]:
    if q.getpixel(pt)==(0xF7,0xF5,0xF1): ImageDraw.floodfill(q,pt,(255,0,255))
q.save(".tmp/logo/quant.png")
vtracer.convert_image_to_svg_py(".tmp/logo/quant.png",".tmp/logo/raw.svg",
    colormode="color",hierarchical="stacked",mode="spline",filter_speckle=12,
    color_precision=8,layer_difference=6,corner_threshold=60,length_threshold=4.0,
    max_iterations=10,splice_threshold=45,path_precision=2)
svg=open(".tmp/logo/raw.svg").read()
paths=re.findall(r'<path [^>]*/>',svg)
def isbg(p):
    m=re.search(r'fill="#([0-9A-Fa-f]{6})"',p); r,g,b=(int(m.group(1)[i:i+2],16) for i in (0,2,4))
    return r>200 and g<80 and b>200
keep=[p for p in paths if not isbg(p)]
# eye contour: thin tapered arc around the eye (source: CoatiLogo2 eye, center 789.5,525.9 r 32.6 in 2048 px)
s=1200/1800; cx,cy,R=(789.5-180)*s,(525.9-127)*s,32.6*s
a0,a1=-100,170; N=80; outer=[]; inner=[]
for i in range(N+1):
    t=i/N; ang=math.radians(a0+(a1-a0)*t); hw=(0.75+1.35*math.sin(math.pi*t))*s
    outer.append((cx+(R+hw)*math.cos(ang),cy+(R+hw)*math.sin(ang)))
    inner.append((cx+(R-hw)*math.cos(ang),cy+(R-hw)*math.sin(ang)))
pts=outer+inner[::-1]
eye='<path d="M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in pts)+' Z" fill="#FBF9F5"/>'
out=('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200">\n'
     +'\n'.join(keep)+'\n'+eye+'\n</svg>\n')
open(".tmp/logo/coati.svg","w").write(out)
print("paths kept",len(keep),"of",len(paths))
