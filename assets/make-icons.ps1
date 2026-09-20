# Regenerates every icon in public/ from assets/shark-source.png (black silhouette on white).
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File assets/make-icons.ps1
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class SharkIcons {
  // Silhouette -> bitmap in colour `fg` whose alpha is the pixel darkness, cropped to the shape.
  public static Bitmap Mask(string src, Color fg) {
    using (var img = new Bitmap(src)) {
      int W = img.Width, H = img.Height, minX = W, minY = H, maxX = -1, maxY = -1;
      var d = img.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var buf = new byte[d.Stride * H]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); img.UnlockBits(d);
      var dark = new byte[W * H];
      for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        int i = y * d.Stride + x * 4;
        int lum = (buf[i] * 114 + buf[i + 1] * 587 + buf[i + 2] * 299) / 1000;
        int a = 255 - lum; dark[y * W + x] = (byte)a;
        if (a > 128) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      int w = maxX - minX + 1, h = maxY - minY + 1;
      var o = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      var od = o.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      var ob = new byte[od.Stride * h];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int p = y * od.Stride + x * 4;
        ob[p] = fg.B; ob[p + 1] = fg.G; ob[p + 2] = fg.R; ob[p + 3] = dark[(y + minY) * W + (x + minX)];
      }
      Marshal.Copy(ob, 0, od.Scan0, ob.Length); o.UnlockBits(od);
      return o;
    }
  }
  static void Quality(Graphics g) {
    g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.CompositingQuality = CompositingQuality.HighQuality;
  }
  // Square tile: background (rounded by radiusFrac of size, 0 = square) with the shark filling `fill` of the width.
  public static void Tile(Bitmap shark, int size, double fill, double radiusFrac, Color bg, string path) {
    using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      Quality(g); g.Clear(Color.Transparent);
      float r = (float)(size * radiusFrac);
      using (var gp = new GraphicsPath()) {
        if (r <= 0) gp.AddRectangle(new RectangleF(0, 0, size, size));
        else {
          gp.AddArc(0, 0, 2 * r, 2 * r, 180, 90); gp.AddArc(size - 2 * r, 0, 2 * r, 2 * r, 270, 90);
          gp.AddArc(size - 2 * r, size - 2 * r, 2 * r, 2 * r, 0, 90); gp.AddArc(0, size - 2 * r, 2 * r, 2 * r, 90, 90); gp.CloseFigure();
        }
        using (var br = new SolidBrush(bg)) g.FillPath(br, gp);
      }
      double tw = size * fill, th = tw * shark.Height / shark.Width;
      g.DrawImage(shark, new RectangleF((float)((size - tw) / 2), (float)((size - th) / 2), (float)tw, (float)th));
      bmp.Save(path, ImageFormat.Png);
    }
  }
  // Just the shark on a transparent background, scaled to width w.
  public static void Mark(Bitmap shark, int w, string path) {
    int h = (int)Math.Round((double)w * shark.Height / shark.Width);
    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      Quality(g); g.Clear(Color.Transparent);
      g.DrawImage(shark, new RectangleF(0, 0, w, h)); bmp.Save(path, ImageFormat.Png);
    }
  }
}
"@

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'assets\shark-source.png'
$pub = Join-Path $root 'public'
$blue = [System.Drawing.Color]::FromArgb(255, 0x25, 0x63, 0xEB)

$white = [SharkIcons]::Mask($src, [System.Drawing.Color]::White)
$black = [SharkIcons]::Mask($src, [System.Drawing.Color]::Black)
"shark bounding box: $($white.Width) x $($white.Height)"

[SharkIcons]::Tile($white, 512, 0.78, 0.22, $blue, (Join-Path $pub 'icon-512.png'))
[SharkIcons]::Tile($white, 192, 0.78, 0.22, $blue, (Join-Path $pub 'icon-192.png'))
[SharkIcons]::Tile($white, 512, 0.62, 0.00, $blue, (Join-Path $pub 'icon-512-maskable.png'))  # Android safe zone
[SharkIcons]::Tile($white, 180, 0.78, 0.00, $blue, (Join-Path $pub 'icon-180.png'))           # iOS rounds it itself
[SharkIcons]::Tile($white, 64,  0.84, 0.22, $blue, (Join-Path $pub 'favicon.png'))
[SharkIcons]::Mark($black, 400, (Join-Path $pub 'logo.png'))                                   # header mark (CSS mask)
$white.Dispose(); $black.Dispose()
"done"
