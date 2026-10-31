// The iPhone app's icon and launch image, drawn from the owner app's mark (apps/inbox/public/favicon.svg,
// the same shapes as the Android icon): a sunset half-disc over two ink lines, on the #f6f5ff ground.
// Opaque, as the App Store wants its 1024 px icon. Runs on any Mac with the Command Line Tools:
//
//   swift apps/mobile/scripts/ios-art.swift apps/mobile/ios/App/App/Assets.xcassets
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

/// The mark, in its own 64-unit box, `units` pixels per unit, centred on a `size` px square.
func draw(size: Int, units: CGFloat) -> CGImage {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.setFillColor(color(0xf6f5ff))
  ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
  // SVG coordinates (y down), the drawing's own box x 4…60, y 8…53.5 centred.
  let s = CGFloat(size)
  ctx.translateBy(x: s / 2 - 32 * units, y: s / 2 + 30.75 * units)
  ctx.scaleBy(x: units, y: -units)

  ctx.saveGState()
  ctx.move(to: CGPoint(x: 4, y: 36))
  ctx.addArc(center: CGPoint(x: 32, y: 36), radius: 28, startAngle: .pi, endAngle: 0, clockwise: false)
  ctx.closePath()
  ctx.clip()
  let gradient = CGGradient(
    colorsSpace: space, colors: [color(0xff9650), color(0xff6fa8), color(0x8a6bff)] as CFArray,
    locations: [0, 0.58, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: 32, y: 8), end: CGPoint(x: 32, y: 36), options: [])
  ctx.setFillColor(color(0xf6f5ff))
  ctx.fill([
    CGRect(x: 4, y: 21, width: 56, height: 1.5), CGRect(x: 4, y: 25, width: 56, height: 2),
    CGRect(x: 4, y: 29.5, width: 56, height: 2.5),
  ])
  ctx.restoreGState()

  ctx.setLineWidth(3)
  ctx.setLineCap(.round)
  ctx.setStrokeColor(color(0x14163c))
  ctx.strokeLineSegments(between: [CGPoint(x: 8, y: 44), CGPoint(x: 56, y: 44)])
  ctx.setStrokeColor(color(0x14163c, 0.5))
  ctx.strokeLineSegments(between: [CGPoint(x: 14, y: 52), CGPoint(x: 50, y: 52)])
  return ctx.makeImage()!
}

func write(_ image: CGImage, _ path: String) {
  let url = URL(fileURLWithPath: path)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("cannot write \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(path)") }
  print("wrote \(path)")
}

let assets = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ios/App/App/Assets.xcassets"
// The icon: the mark across about 60% of the square (iOS rounds the corners itself).
write(draw(size: 1024, units: 10), "\(assets)/AppIcon.appiconset/AppIcon-512@2x.png")
// The launch image: the mark small in the middle of the ground, as Android's splash shows it.
let splash = draw(size: 2732, units: 6)
for name in ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"] {
  write(splash, "\(assets)/Splash.imageset/\(name)")
}
