// Renders docs/brand/app-icon.svg to the 1024 px PNG that `ekip terminal install` turns into
// ekip.app's icon (plugin/assets/ekip-app-icon.png). Run after changing the SVG:
//   swift scripts/app-icon.swift docs/brand/app-icon.svg plugin/assets/ekip-app-icon.png
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let svg = NSImage(contentsOfFile: args[1]) else { print("usage: app-icon.swift <in.svg> <out.png>"); exit(1) }
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
svg.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
